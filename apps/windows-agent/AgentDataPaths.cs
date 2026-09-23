using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HurogiCollector;

internal sealed record AgentDataRootPreparation(
    string RootPath,
    bool MigratedFromLegacy,
    string LegacyRootPath,
    bool LegacyBackupRetained);

/// <summary>
/// Owns the user-visible Agent data root. Internal namespaces, wire identifiers,
/// and installer identities intentionally remain compatible with older releases.
/// </summary>
internal static class AgentDataPaths
{
    internal const string CurrentDirectoryName = "ByeollogAgent";
    internal const string LegacyDirectoryName = "HurogiCollector";
    private static readonly UTF8Encoding Utf8NoBom = new(false);

    internal static string CurrentRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        CurrentDirectoryName);

    internal static string LegacyRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        LegacyDirectoryName);

    internal static AgentDataRootPreparation PrepareDataRoot()
    {
        var current = Path.GetFullPath(CurrentRoot);
        var legacy = Path.GetFullPath(LegacyRoot);
        var parent = Path.GetDirectoryName(current)
            ?? throw new InvalidOperationException("별록 에이전트 데이터 폴더의 상위 경로가 없습니다.");

        Directory.CreateDirectory(parent);
        EnsureOrdinaryDirectoryIfPresent(current, "현재 별록 에이전트 데이터 폴더");
        EnsureOrdinaryDirectoryIfPresent(legacy, "기존 별록 데이터 폴더");

        if (Directory.Exists(current))
        {
            return new AgentDataRootPreparation(
                current,
                MigratedFromLegacy: false,
                legacy,
                LegacyBackupRetained: Directory.Exists(legacy));
        }

        if (!Directory.Exists(legacy))
        {
            Directory.CreateDirectory(current);
            return new AgentDataRootPreparation(
                current,
                MigratedFromLegacy: false,
                legacy,
                LegacyBackupRetained: false);
        }

        var staging = Path.Combine(parent, ".ByeollogAgent-migration-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            CopyDirectoryVerified(legacy, staging);
            WriteMigrationMarker(staging, legacy);
            Directory.Move(staging, current);
        }
        catch
        {
            TryDeleteOwnedStaging(staging);
            throw;
        }

        // The old directory is deliberately retained as a rollback-only backup.
        // Every current release reads and writes only the ByeollogAgent directory.
        return new AgentDataRootPreparation(
            current,
            MigratedFromLegacy: true,
            legacy,
            LegacyBackupRetained: true);
    }

    private static void CopyDirectoryVerified(string sourceRoot, string destinationRoot)
    {
        var pending = new Stack<string>();
        pending.Push(sourceRoot);
        while (pending.Count > 0)
        {
            var sourceDirectory = pending.Pop();
            foreach (var childDirectory in Directory.EnumerateDirectories(sourceDirectory, "*", SearchOption.TopDirectoryOnly))
            {
                RejectReparsePoint(childDirectory, "기존 별록 데이터의 하위 폴더");
                var relativeDirectory = GetSafeRelativePath(sourceRoot, childDirectory);
                Directory.CreateDirectory(Path.Combine(destinationRoot, relativeDirectory));
                pending.Push(childDirectory);
            }

            foreach (var sourceFile in Directory.EnumerateFiles(sourceDirectory, "*", SearchOption.TopDirectoryOnly))
            {
                RejectReparsePoint(sourceFile, "기존 별록 데이터 파일");
                var relative = GetSafeRelativePath(sourceRoot, sourceFile);
                var destination = Path.Combine(destinationRoot, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                File.Copy(sourceFile, destination, overwrite: false);

                using var sourceStream = File.Open(sourceFile, FileMode.Open, FileAccess.Read, FileShare.Read);
                using var destinationStream = File.Open(destination, FileMode.Open, FileAccess.Read, FileShare.Read);
                var sourceHash = SHA256.HashData(sourceStream);
                var destinationHash = SHA256.HashData(destinationStream);
                if (!CryptographicOperations.FixedTimeEquals(sourceHash, destinationHash))
                    throw new IOException("기존 별록 설정을 새 데이터 폴더로 검증 복사하지 못했습니다.");

                File.SetLastWriteTimeUtc(destination, File.GetLastWriteTimeUtc(sourceFile));
            }
        }
    }

    private static string GetSafeRelativePath(string root, string path)
    {
        var relative = Path.GetRelativePath(root, path);
        if (relative == "." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || relative == ".." || Path.IsPathRooted(relative))
        {
            throw new IOException("기존 별록 데이터 경로가 허용 범위를 벗어났습니다.");
        }
        return relative;
    }

    private static void WriteMigrationMarker(string stagingRoot, string legacyRoot)
    {
        var marker = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            migratedAtUtc = DateTimeOffset.UtcNow,
            fromDirectoryName = LegacyDirectoryName,
            toDirectoryName = CurrentDirectoryName,
            legacyBackupRetained = true
        }, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(stagingRoot, "data-root-migration.json"), marker, Utf8NoBom);
    }

    private static void EnsureOrdinaryDirectoryIfPresent(string path, string label)
    {
        if (!Directory.Exists(path)) return;
        RejectReparsePoint(path, label);
    }

    private static void RejectReparsePoint(string path, string label)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException(label + "는 바로가기 또는 재분석 지점일 수 없습니다.");
    }

    private static void TryDeleteOwnedStaging(string path)
    {
        try
        {
            if (!Directory.Exists(path)) return;
            RejectReparsePoint(path, "마이그레이션 임시 폴더");
            Directory.Delete(path, recursive: true);
        }
        catch { }
    }
}
