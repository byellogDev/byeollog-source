using System.Reflection;
using System.Runtime.InteropServices;

namespace HurogiCollector;

internal sealed class NativeSqliteException : Exception
{
    public NativeSqliteException(string message, int resultCode)
        : base($"{message} (SQLite {resultCode})")
    {
        ResultCode = resultCode;
    }

    public int ResultCode { get; }
}

/// <summary>
/// Local Agent 전용 최소 SQLite 래퍼입니다. Windows 10/11에 기본 포함된
/// winsqlite3.dll을 사용하므로 별도 native DLL이나 NuGet 패키지를 배포하지 않습니다.
/// Linux 검증 환경에서는 시스템 libsqlite3로 같은 코드를 실행합니다.
/// </summary>
internal sealed class NativeSqliteDatabase : IDisposable
{
    private const string ImportName = "byeollog_sqlite3";
    private const int Ok = 0;
    private const int Row = 100;
    private const int Done = 101;
    private const int OpenReadWrite = 0x00000002;
    private const int OpenCreate = 0x00000004;
    private const int OpenFullMutex = 0x00010000;
    private const int Integer = 1;
    private const int Float = 2;
    private const int Text = 3;
    private const int Blob = 4;
    private static readonly IntPtr Transient = new(-1);
    private readonly object _gate = new();
    private IntPtr _database;
    private bool _disposed;

    static NativeSqliteDatabase()
    {
        NativeLibrary.SetDllImportResolver(typeof(NativeSqliteDatabase).Assembly, ResolveLibrary);
    }

    public NativeSqliteDatabase(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("SQLite 경로가 필요합니다.", nameof(path));
        var result = Native.sqlite3_open_v2(path, out _database, OpenReadWrite | OpenCreate | OpenFullMutex, IntPtr.Zero);
        if (result != Ok)
        {
            var message = ErrorMessage();
            if (_database != IntPtr.Zero) Native.sqlite3_close_v2(_database);
            _database = IntPtr.Zero;
            throw new NativeSqliteException(message, result);
        }

        ThrowIfError(Native.sqlite3_busy_timeout(_database, 5000), "SQLite busy timeout 설정 실패");
    }

    private static IntPtr ResolveLibrary(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!string.Equals(libraryName, ImportName, StringComparison.Ordinal)) return IntPtr.Zero;
        var candidates = OperatingSystem.IsWindows()
            ? new[] { "winsqlite3.dll" }
            : new[] { "libsqlite3.so.0", "libsqlite3.so", "libsqlite3.dylib" };
        foreach (var candidate in candidates)
        {
            if (NativeLibrary.TryLoad(candidate, assembly, searchPath, out var handle)) return handle;
            if (NativeLibrary.TryLoad(candidate, out handle)) return handle;
        }
        throw new DllNotFoundException("운영체제 SQLite 라이브러리를 찾지 못했습니다.");
    }

    public void ExecuteScript(string sql)
    {
        lock (_gate)
        {
            EnsureOpen();
            ExecuteScriptLocked(sql);
        }
    }

    public int Execute(string sql, params object?[] parameters)
    {
        lock (_gate)
        {
            EnsureOpen();
            using var statement = PrepareLocked(sql, parameters);
            var result = Native.sqlite3_step(statement.Handle);
            if (result != Done) throw new NativeSqliteException(ErrorMessage(), result);
            return Native.sqlite3_changes(_database);
        }
    }

    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Query(string sql, params object?[] parameters)
    {
        lock (_gate)
        {
            EnsureOpen();
            using var statement = PrepareLocked(sql, parameters);
            var rows = new List<IReadOnlyDictionary<string, object?>>();
            while (true)
            {
                var result = Native.sqlite3_step(statement.Handle);
                if (result == Done) break;
                if (result != Row) throw new NativeSqliteException(ErrorMessage(), result);
                rows.Add(ReadRow(statement.Handle));
            }
            return rows;
        }
    }

    public IReadOnlyDictionary<string, object?>? QuerySingle(string sql, params object?[] parameters)
    {
        return Query(sql, parameters).FirstOrDefault();
    }

    public T Transaction<T>(Func<T> callback)
    {
        lock (_gate)
        {
            EnsureOpen();
            ExecuteScriptLocked("BEGIN IMMEDIATE;");
            try
            {
                var result = callback();
                ExecuteScriptLocked("COMMIT;");
                return result;
            }
            catch
            {
                try { ExecuteScriptLocked("ROLLBACK;"); } catch { }
                throw;
            }
        }
    }

    public void Transaction(Action callback)
    {
        Transaction(() =>
        {
            callback();
            return true;
        });
    }

    private void ExecuteScriptLocked(string sql)
    {
        var result = Native.sqlite3_exec(_database, sql, IntPtr.Zero, IntPtr.Zero, out var errorPointer);
        if (result == Ok) return;
        var message = errorPointer == IntPtr.Zero
            ? ErrorMessage()
            : Marshal.PtrToStringUTF8(errorPointer) ?? "SQLite 실행 오류";
        if (errorPointer != IntPtr.Zero) Native.sqlite3_free(errorPointer);
        throw new NativeSqliteException(message, result);
    }

    private SqliteStatement PrepareLocked(string sql, object?[] parameters)
    {
        var result = Native.sqlite3_prepare_v2(_database, sql, -1, out var statement, IntPtr.Zero);
        if (result != Ok) throw new NativeSqliteException(ErrorMessage(), result);
        var wrapper = new SqliteStatement(statement);
        try
        {
            for (var index = 0; index < parameters.Length; index++)
                Bind(statement, index + 1, parameters[index]);
            return wrapper;
        }
        catch
        {
            wrapper.Dispose();
            throw;
        }
    }

    private void Bind(IntPtr statement, int index, object? value)
    {
        int result;
        if (value is null)
            result = Native.sqlite3_bind_null(statement, index);
        else if (value is bool boolean)
            result = Native.sqlite3_bind_int64(statement, index, boolean ? 1 : 0);
        else if (value is byte or sbyte or short or ushort or int or uint or long)
            result = Native.sqlite3_bind_int64(statement, index, Convert.ToInt64(value));
        else if (value is float or double or decimal)
            result = Native.sqlite3_bind_double(statement, index, Convert.ToDouble(value));
        else
            result = Native.sqlite3_bind_text(statement, index, Convert.ToString(value) ?? "", -1, Transient);
        if (result != Ok) throw new NativeSqliteException(ErrorMessage(), result);
    }

    private static IReadOnlyDictionary<string, object?> ReadRow(IntPtr statement)
    {
        var values = new Dictionary<string, object?>(StringComparer.Ordinal);
        var count = Native.sqlite3_column_count(statement);
        for (var index = 0; index < count; index++)
        {
            var name = Marshal.PtrToStringUTF8(Native.sqlite3_column_name(statement, index)) ?? $"column_{index}";
            values[name] = Native.sqlite3_column_type(statement, index) switch
            {
                Integer => Native.sqlite3_column_int64(statement, index),
                Float => Native.sqlite3_column_double(statement, index),
                Text => ReadText(statement, index),
                Blob => ReadBlob(statement, index),
                _ => null
            };
        }
        return values;
    }

    private static string ReadText(IntPtr statement, int index)
    {
        var pointer = Native.sqlite3_column_text(statement, index);
        if (pointer == IntPtr.Zero) return "";
        return Marshal.PtrToStringUTF8(pointer, Native.sqlite3_column_bytes(statement, index)) ?? "";
    }

    private static byte[] ReadBlob(IntPtr statement, int index)
    {
        var length = Native.sqlite3_column_bytes(statement, index);
        if (length <= 0) return Array.Empty<byte>();
        var result = new byte[length];
        Marshal.Copy(Native.sqlite3_column_blob(statement, index), result, 0, length);
        return result;
    }

    private string ErrorMessage()
    {
        if (_database == IntPtr.Zero) return "SQLite 데이터베이스를 열지 못했습니다.";
        return Marshal.PtrToStringUTF8(Native.sqlite3_errmsg(_database)) ?? "SQLite 오류";
    }

    private void ThrowIfError(int result, string message)
    {
        if (result != Ok) throw new NativeSqliteException(message + ": " + ErrorMessage(), result);
    }

    private void EnsureOpen()
    {
        ObjectDisposedException.ThrowIf(_disposed || _database == IntPtr.Zero, this);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            if (_database != IntPtr.Zero)
            {
                Native.sqlite3_close_v2(_database);
                _database = IntPtr.Zero;
            }
        }
    }

    private sealed class SqliteStatement : IDisposable
    {
        public SqliteStatement(IntPtr handle) => Handle = handle;
        public IntPtr Handle { get; private set; }

        public void Dispose()
        {
            if (Handle == IntPtr.Zero) return;
            Native.sqlite3_finalize(Handle);
            Handle = IntPtr.Zero;
        }
    }

    private static class Native
    {
        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_open_v2(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string filename,
            out IntPtr database,
            int flags,
            IntPtr vfs);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_close_v2(IntPtr database);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_busy_timeout(IntPtr database, int milliseconds);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_exec(
            IntPtr database,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
            IntPtr callback,
            IntPtr callbackArgument,
            out IntPtr errorMessage);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern void sqlite3_free(IntPtr pointer);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_prepare_v2(
            IntPtr database,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
            int byteCount,
            out IntPtr statement,
            IntPtr tail);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_step(IntPtr statement);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_finalize(IntPtr statement);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_bind_null(IntPtr statement, int index);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_bind_int64(IntPtr statement, int index, long value);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_bind_double(IntPtr statement, int index, double value);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_bind_text(
            IntPtr statement,
            int index,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string value,
            int byteCount,
            IntPtr destructor);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_changes(IntPtr database);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr sqlite3_errmsg(IntPtr database);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_column_count(IntPtr statement);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr sqlite3_column_name(IntPtr statement, int index);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_column_type(IntPtr statement, int index);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern long sqlite3_column_int64(IntPtr statement, int index);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern double sqlite3_column_double(IntPtr statement, int index);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr sqlite3_column_text(IntPtr statement, int index);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr sqlite3_column_blob(IntPtr statement, int index);

        [DllImport(ImportName, CallingConvention = CallingConvention.Cdecl)]
        internal static extern int sqlite3_column_bytes(IntPtr statement, int index);
    }
}
