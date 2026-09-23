using System.Reflection;
using System.Runtime.InteropServices;

namespace HurogiCollector;

internal static class KoreanTicketCounter
{
    private static readonly string[] NativeOnes =
        ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
    private static readonly string[] NativeTens =
        ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];
    private static readonly string[] SinoDigits =
        ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];

    internal static string Format(int count)
    {
        if (count is < 1 or > 100_000)
            throw new ArgumentOutOfRangeException(nameof(count));

        if (count < 100) return NativeUnderOneHundred(count) + " 장";
        var remainder = count % 100;
        var prefix = Sino(count - remainder);
        return remainder == 0
            ? prefix + " 장"
            : prefix + " " + NativeUnderOneHundred(remainder) + " 장";
    }

    private static string NativeUnderOneHundred(int value)
    {
        if (value is < 1 or > 99) throw new ArgumentOutOfRangeException(nameof(value));
        if (value < 10) return NativeOnes[value];
        var tens = value / 10;
        var ones = value % 10;
        var prefix = tens == 2 && ones == 0 ? "스무" : NativeTens[tens];
        return prefix + NativeOnes[ones];
    }

    private static string Sino(int value)
    {
        if (value is < 1 or > 100_000) throw new ArgumentOutOfRangeException(nameof(value));
        if (value < 10_000) return SinoUnderTenThousand(value);
        var man = value / 10_000;
        var remainder = value % 10_000;
        var prefix = (man == 1 ? "" : SinoUnderTenThousand(man)) + "만";
        return remainder == 0 ? prefix : prefix + SinoUnderTenThousand(remainder);
    }

    private static string SinoUnderTenThousand(int value)
    {
        var units = new[] { "", "십", "백", "천" };
        var parts = new List<string>();
        for (var position = 3; position >= 0; position--)
        {
            var divisor = (int)Math.Pow(10, position);
            var digit = value / divisor % 10;
            if (digit == 0) continue;
            if (digit != 1 || position == 0) parts.Add(SinoDigits[digit]);
            parts.Add(units[position]);
        }
        return string.Concat(parts);
    }
}

internal static class WindowsTextToSpeech
{
    private const int SpeakAsyncFlag = 1;
    private const int PurgeBeforeSpeakFlag = 2;
    private static readonly SemaphoreSlim SpeechGate = new(1, 1);

    internal static async Task SpeakAsync(
        string text,
        int volumePercent,
        CancellationToken cancellationToken,
        Action<string>? log = null)
    {
        text = (text ?? "").Trim();
        if (text.Length is < 1 or > 256) throw new ArgumentOutOfRangeException(nameof(text));
        if (volumePercent is < 0 or > 100) throw new ArgumentOutOfRangeException(nameof(volumePercent));
        if (volumePercent == 0) return;

        await SpeechGate.WaitAsync(cancellationToken);
        try
        {
            await SpeakOnStaThreadAsync(text, volumePercent, cancellationToken, log);
        }
        finally
        {
            SpeechGate.Release();
        }
    }

    private static Task SpeakOnStaThreadAsync(
        string text,
        int volumePercent,
        CancellationToken cancellationToken,
        Action<string>? log)
    {
        var completion = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            object? voice = null;
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                var voiceType = Type.GetTypeFromProgID("SAPI.SpVoice", throwOnError: false)
                    ?? throw new PlatformNotSupportedException("Windows 음성 합성기를 찾지 못했습니다.");
                voice = Activator.CreateInstance(voiceType)
                    ?? throw new InvalidOperationException("Windows 음성 합성기를 시작하지 못했습니다.");
                TrySelectKoreanVoice(voice, log);
                voiceType.InvokeMember(
                    "Volume",
                    BindingFlags.SetProperty,
                    binder: null,
                    target: voice,
                    args: [volumePercent]);
                voiceType.InvokeMember(
                    "Speak",
                    BindingFlags.InvokeMethod,
                    binder: null,
                    target: voice,
                    args: [text, SpeakAsyncFlag]);

                while (true)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        voiceType.InvokeMember(
                            "Speak",
                            BindingFlags.InvokeMethod,
                            binder: null,
                            target: voice,
                            args: ["", SpeakAsyncFlag | PurgeBeforeSpeakFlag]);
                        cancellationToken.ThrowIfCancellationRequested();
                    }
                    var finished = voiceType.InvokeMember(
                        "WaitUntilDone",
                        BindingFlags.InvokeMethod,
                        binder: null,
                        target: voice,
                        args: [100]);
                    if (finished is bool completed
                            ? completed
                            : Convert.ToBoolean(finished, System.Globalization.CultureInfo.InvariantCulture))
                        break;
                }
                completion.TrySetResult();
            }
            catch (OperationCanceledException ex)
            {
                completion.TrySetCanceled(ex.CancellationToken);
            }
            catch (Exception ex)
            {
                completion.TrySetException(ex);
            }
            finally
            {
                if (voice is not null && Marshal.IsComObject(voice))
                    Marshal.FinalReleaseComObject(voice);
            }
        })
        {
            IsBackground = true,
            Name = "Byeollog raffle TTS"
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return completion.Task;
    }

    private static void TrySelectKoreanVoice(object voice, Action<string>? log)
    {
        object? voices = null;
        object? token = null;
        try
        {
            var type = voice.GetType();
            voices = type.InvokeMember(
                "GetVoices",
                BindingFlags.InvokeMethod,
                binder: null,
                target: voice,
                args: ["Language=412", ""]);
            if (voices is null) return;
            var count = Convert.ToInt32(voices.GetType().InvokeMember(
                "Count", BindingFlags.GetProperty, null, voices, null));
            if (count < 1) return;
            token = voices.GetType().InvokeMember(
                "Item", BindingFlags.InvokeMethod, null, voices, [0]);
            if (token is not null)
                type.InvokeMember("Voice", BindingFlags.SetProperty, null, voice, [token]);
        }
        catch (Exception ex)
        {
            log?.Invoke("한국어 TTS 음성 선택 보류 · type=" + ex.GetType().Name);
        }
        finally
        {
            if (token is not null && Marshal.IsComObject(token)) Marshal.FinalReleaseComObject(token);
            if (voices is not null && Marshal.IsComObject(voices)) Marshal.FinalReleaseComObject(voices);
        }
    }
}
