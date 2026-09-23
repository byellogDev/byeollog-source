using System.Runtime.InteropServices;

namespace HurogiCollector;

/// <summary>
/// Windows Core Audio를 관리형 COM 캐스팅 없이 호출합니다.
/// CoCreateInstance가 요청한 IID 포인터를 직접 반환하고, 각 인터페이스의
/// IUnknown 기반 vtable을 호출해 .NET RCW의 E_NOINTERFACE 변환 경로를 피합니다.
/// </summary>
internal static class CoreAudioNativeApi
{
    private static readonly Guid MMDeviceEnumeratorClassId = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    private static readonly Guid MMDeviceEnumeratorInterfaceId = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    private static readonly Guid AudioEndpointVolumeInterfaceId = new("5CDF2C82-841E-4546-9722-0CF74078229A");
    private static readonly PropertyKey FriendlyNameKey = new(
        new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
        14);

    public static IReadOnlyList<WindowsCaptureEndpoint> ListActiveEndpoints()
    {
        EnsureWindows();
        try
        {
            using var com = ComApartmentScope.Enter();
            IntPtr enumerator = IntPtr.Zero;
            IntPtr collection = IntPtr.Zero;
            try
            {
                enumerator = CreateEnumerator();
                var enumerate = Method<EnumAudioEndpointsDelegate>(enumerator, 3);
                ThrowIfFailed(enumerate(
                    enumerator,
                    DataFlow.Capture,
                    DeviceState.Active,
                    out collection));

                var getCount = Method<GetCountDelegate>(collection, 3);
                ThrowIfFailed(getCount(collection, out var count));
                var defaultId = TryGetDefaultCaptureId(enumerator);
                var result = new List<WindowsCaptureEndpoint>((int)count);
                Exception? firstDeviceError = null;

                for (uint index = 0; index < count; index++)
                {
                    IntPtr device = IntPtr.Zero;
                    try
                    {
                        var item = Method<CollectionItemDelegate>(collection, 4);
                        ThrowIfFailed(item(collection, index, out device));
                        var id = GetId(device);
                        var name = GetFriendlyNameBestEffort(device);
                        if (string.IsNullOrWhiteSpace(name)) name = "이름 없는 캡처 장치";
                        result.Add(new WindowsCaptureEndpoint(
                            id,
                            name,
                            string.Equals(id, defaultId, StringComparison.Ordinal)));
                    }
                    catch (Exception ex)
                    {
                        firstDeviceError ??= ex;
                    }
                    finally
                    {
                        Release(ref device);
                    }
                }

                if (result.Count == 0 && count > 0 && firstDeviceError is not null)
                    throw new CoreAudioCaptureException("장치 정보 읽기", firstDeviceError);

                return result
                    .OrderByDescending(endpoint => endpoint.IsDefault)
                    .ThenBy(endpoint => endpoint.FriendlyName, StringComparer.CurrentCultureIgnoreCase)
                    .ToArray();
            }
            finally
            {
                Release(ref collection);
                Release(ref enumerator);
            }
        }
        catch (CoreAudioCaptureException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new CoreAudioCaptureException("장치 목록 읽기", ex);
        }
    }

    public static bool GetMute(string endpointId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureWindows();
        try
        {
            using var com = ComApartmentScope.Enter();
            IntPtr enumerator = IntPtr.Zero;
            IntPtr device = IntPtr.Zero;
            IntPtr volume = IntPtr.Zero;
            try
            {
                enumerator = CreateEnumerator();
                device = GetDevice(enumerator, endpointId);
                volume = ActivateEndpointVolume(device);
                cancellationToken.ThrowIfCancellationRequested();

                var getMute = Method<GetMuteDelegate>(volume, 15);
                ThrowIfFailed(getMute(volume, out var muted));
                return muted != 0;
            }
            finally
            {
                Release(ref volume);
                Release(ref device);
                Release(ref enumerator);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new CoreAudioCaptureException("음소거 상태 읽기", ex);
        }
    }

    public static void SetMute(
        string endpointId,
        bool muted,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureWindows();
        try
        {
            using var com = ComApartmentScope.Enter();
            IntPtr enumerator = IntPtr.Zero;
            IntPtr device = IntPtr.Zero;
            IntPtr volume = IntPtr.Zero;
            try
            {
                enumerator = CreateEnumerator();
                device = GetDevice(enumerator, endpointId);
                volume = ActivateEndpointVolume(device);
                cancellationToken.ThrowIfCancellationRequested();

                var setMute = Method<SetMuteDelegate>(volume, 14);
                var context = Guid.Empty;
                ThrowIfFailed(setMute(volume, muted ? 1 : 0, ref context));
                cancellationToken.ThrowIfCancellationRequested();

                var getMute = Method<GetMuteDelegate>(volume, 15);
                ThrowIfFailed(getMute(volume, out var verified));
                if ((verified != 0) != muted)
                    throw new InvalidDataException("Windows capture endpoint mute verification failed.");
            }
            finally
            {
                Release(ref volume);
                Release(ref device);
                Release(ref enumerator);
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new CoreAudioCaptureException("음소거 상태 변경", ex);
        }
    }

    private static IntPtr CreateEnumerator()
    {
        var classId = MMDeviceEnumeratorClassId;
        var interfaceId = MMDeviceEnumeratorInterfaceId;
        ThrowIfFailed(CoCreateInstance(
            ref classId,
            IntPtr.Zero,
            ClassContext.All,
            ref interfaceId,
            out var enumerator));
        if (enumerator == IntPtr.Zero)
            throw new InvalidOperationException("Windows MMDevice enumerator pointer is empty.");
        return enumerator;
    }

    private static IntPtr GetDevice(IntPtr enumerator, string endpointId)
    {
        var getDevice = Method<GetDeviceDelegate>(enumerator, 5);
        ThrowIfFailed(getDevice(enumerator, endpointId, out var device));
        if (device == IntPtr.Zero)
            throw new InvalidDataException("Windows capture endpoint pointer is empty.");
        return device;
    }

    private static string? TryGetDefaultCaptureId(IntPtr enumerator)
    {
        IntPtr device = IntPtr.Zero;
        try
        {
            var getDefault = Method<GetDefaultAudioEndpointDelegate>(enumerator, 4);
            var result = getDefault(
                enumerator,
                DataFlow.Capture,
                Role.Communications,
                out device);
            return result >= 0 && device != IntPtr.Zero ? GetId(device) : null;
        }
        catch
        {
            return null;
        }
        finally
        {
            Release(ref device);
        }
    }

    private static string GetId(IntPtr device)
    {
        IntPtr value = IntPtr.Zero;
        try
        {
            var getId = Method<GetIdDelegate>(device, 5);
            ThrowIfFailed(getId(device, out value));
            return Marshal.PtrToStringUni(value)
                ?? throw new InvalidDataException("Windows capture endpoint ID is empty.");
        }
        finally
        {
            if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value);
        }
    }

    private static string GetFriendlyNameBestEffort(IntPtr device)
    {
        try
        {
            return GetFriendlyName(device);
        }
        catch
        {
            return "";
        }
    }

    private static string GetFriendlyName(IntPtr device)
    {
        IntPtr store = IntPtr.Zero;
        PropVariant value = default;
        try
        {
            var openProperties = Method<OpenPropertyStoreDelegate>(device, 4);
            ThrowIfFailed(openProperties(device, StorageAccessMode.Read, out store));

            var getValue = Method<GetPropertyValueDelegate>(store, 5);
            var key = FriendlyNameKey;
            ThrowIfFailed(getValue(store, ref key, out value));
            return value.VarType == (ushort)VarEnum.VT_LPWSTR
                ? Marshal.PtrToStringUni(value.PointerValue) ?? ""
                : "";
        }
        finally
        {
            if (value.VarType != 0) PropVariantClear(ref value);
            Release(ref store);
        }
    }

    private static IntPtr ActivateEndpointVolume(IntPtr device)
    {
        var activate = Method<ActivateDelegate>(device, 3);
        var interfaceId = AudioEndpointVolumeInterfaceId;
        ThrowIfFailed(activate(
            device,
            ref interfaceId,
            ClassContext.All,
            IntPtr.Zero,
            out var volume));
        if (volume == IntPtr.Zero)
            throw new InvalidDataException("Windows endpoint volume pointer is empty.");
        return volume;
    }

    private static T Method<T>(IntPtr instance, int slot) where T : Delegate
    {
        if (instance == IntPtr.Zero)
            throw new ArgumentException("COM interface pointer is empty.", nameof(instance));
        var table = Marshal.ReadIntPtr(instance);
        if (table == IntPtr.Zero)
            throw new InvalidDataException("COM interface vtable is empty.");
        var address = Marshal.ReadIntPtr(table, checked(slot * IntPtr.Size));
        if (address == IntPtr.Zero)
            throw new InvalidDataException($"COM vtable slot {slot} is empty.");
        return Marshal.GetDelegateForFunctionPointer<T>(address);
    }

    private static void Release(ref IntPtr instance)
    {
        var value = instance;
        instance = IntPtr.Zero;
        if (value == IntPtr.Zero) return;
        try
        {
            Method<ReleaseDelegate>(value, 2)(value);
        }
        catch
        {
            // Release 실패가 본래 Core Audio 오류를 가리지 않도록 합니다.
        }
    }

    private static void ThrowIfFailed(int hresult)
    {
        if (hresult < 0) Marshal.ThrowExceptionForHR(hresult);
    }

    private static void EnsureWindows()
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Windows Core Audio is available only on Windows.");
    }

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int CoCreateInstance(
        ref Guid classId,
        IntPtr outer,
        ClassContext classContext,
        ref Guid interfaceId,
        out IntPtr instance);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int CoInitializeEx(IntPtr reserved, CoInit concurrencyModel);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern void CoUninitialize();

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int PropVariantClear(ref PropVariant value);

    private sealed class ComApartmentScope : IDisposable
    {
        private const int RpcEChangedMode = unchecked((int)0x80010106);
        private readonly bool _mustUninitialize;

        private ComApartmentScope(bool mustUninitialize)
        {
            _mustUninitialize = mustUninitialize;
        }

        public static ComApartmentScope Enter()
        {
            var result = CoInitializeEx(IntPtr.Zero, CoInit.Multithreaded | CoInit.DisableOle1Dde);
            if (result == RpcEChangedMode)
                return new ComApartmentScope(false);
            ThrowIfFailed(result);
            return new ComApartmentScope(true);
        }

        public void Dispose()
        {
            if (_mustUninitialize) CoUninitialize();
        }
    }

    private enum DataFlow
    {
        Render = 0,
        Capture = 1,
        All = 2
    }

    private enum Role
    {
        Console = 0,
        Multimedia = 1,
        Communications = 2
    }

    [Flags]
    private enum DeviceState : uint
    {
        Active = 0x00000001
    }

    [Flags]
    private enum ClassContext : uint
    {
        InprocServer = 0x1,
        InprocHandler = 0x2,
        LocalServer = 0x4,
        RemoteServer = 0x10,
        All = InprocServer | InprocHandler | LocalServer | RemoteServer
    }

    private enum StorageAccessMode : uint
    {
        Read = 0
    }

    [Flags]
    private enum CoInit : uint
    {
        Multithreaded = 0x0,
        DisableOle1Dde = 0x4
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public PropertyKey(Guid formatId, uint propertyId)
        {
            FormatId = formatId;
            PropertyId = propertyId;
        }

        public Guid FormatId;
        public uint PropertyId;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort VarType;
        [FieldOffset(8)] public IntPtr PointerValue;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate uint ReleaseDelegate(IntPtr self);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int EnumAudioEndpointsDelegate(
        IntPtr self,
        DataFlow dataFlow,
        DeviceState stateMask,
        out IntPtr devices);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetDefaultAudioEndpointDelegate(
        IntPtr self,
        DataFlow dataFlow,
        Role role,
        out IntPtr device);

    [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Unicode)]
    private delegate int GetDeviceDelegate(
        IntPtr self,
        [MarshalAs(UnmanagedType.LPWStr)] string id,
        out IntPtr device);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetCountDelegate(IntPtr self, out uint count);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CollectionItemDelegate(IntPtr self, uint index, out IntPtr device);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ActivateDelegate(
        IntPtr self,
        ref Guid interfaceId,
        ClassContext classContext,
        IntPtr activationParameters,
        out IntPtr activatedInterface);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int OpenPropertyStoreDelegate(
        IntPtr self,
        StorageAccessMode accessMode,
        out IntPtr properties);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetIdDelegate(IntPtr self, out IntPtr id);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetPropertyValueDelegate(
        IntPtr self,
        ref PropertyKey key,
        out PropVariant value);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetMuteDelegate(IntPtr self, int muted, ref Guid eventContext);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetMuteDelegate(IntPtr self, out int muted);
}
