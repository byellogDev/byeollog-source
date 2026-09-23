using System.Text;
using System.Text.Json;

namespace HurogiCollector;

internal sealed class TimedMuteRecoveryStore : ITimedMuteRecoveryStore
{
    private readonly string _path;
    private readonly object _gate = new();
    private readonly JsonSerializerOptions _json = new() { WriteIndented = true };

    public TimedMuteRecoveryStore(string rootPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootPath);
        _path = Path.Combine(rootPath, "timed_mute_recovery.json");
    }

    public TimedMuteRecoveryRecord? Load()
    {
        lock (_gate)
        {
            if (!File.Exists(_path)) return null;
            var record = JsonSerializer.Deserialize<TimedMuteRecoveryRecord>(
                File.ReadAllText(_path, Encoding.UTF8));
            if (record is null)
                throw new InvalidDataException("Timed mute recovery journal is empty.");
            TimedMuteCoordinator.ValidateRecoveryRecord(record);
            return record;
        }
    }

    public void Save(TimedMuteRecoveryRecord record)
    {
        TimedMuteCoordinator.ValidateRecoveryRecord(record);
        lock (_gate)
        {
            var temporaryPath = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(
                    temporaryPath,
                    JsonSerializer.Serialize(record, _json),
                    new UTF8Encoding(false));
                File.Move(temporaryPath, _path, overwrite: true);
            }
            finally
            {
                try { if (File.Exists(temporaryPath)) File.Delete(temporaryPath); } catch { }
            }
        }
    }

    public void Clear(string operationId)
    {
        lock (_gate)
        {
            if (!File.Exists(_path)) return;
            var current = JsonSerializer.Deserialize<TimedMuteRecoveryRecord>(
                File.ReadAllText(_path, Encoding.UTF8));
            if (current is null || !string.Equals(current.OperationId, operationId, StringComparison.Ordinal))
                throw new InvalidOperationException("Timed mute recovery journal changed unexpectedly.");
            File.Delete(_path);
        }
    }
}
