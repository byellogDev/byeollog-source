using System.Text;

namespace HurogiCollector;

/// <summary>
/// Removes the refresh-token vault used by older internal builds and keeps a
/// disconnect tombstone. General releases never persist or restore an automation
/// session; this class exists only to make that policy durable across upgrades.
/// </summary>
internal sealed class VNextSessionVault
{
    private readonly string _directory;
    private readonly string _vaultPath;
    private readonly string _tombstonePath;

    public VNextSessionVault(string rootPath)
    {
        if (string.IsNullOrWhiteSpace(rootPath)) throw new ArgumentException("세션 저장 경로가 필요합니다.", nameof(rootPath));
        _directory = Path.Combine(Path.GetFullPath(rootPath), "vnext-session");
        _vaultPath = Path.Combine(_directory, "refresh-token.v1.dpapi");
        _tombstonePath = Path.Combine(_directory, "disconnect.v1");
    }

    public void MarkDisconnectedAndDelete()
    {
        SuppressRestoreAndDelete();
    }

    public void SuppressRestoreAndDelete()
    {
        Directory.CreateDirectory(_directory);
        File.WriteAllText(_tombstonePath, "explicit-disconnect-v1", new UTF8Encoding(false));
        try { if (File.Exists(_vaultPath)) File.Delete(_vaultPath); }
        catch
        {
            // The tombstone intentionally remains authoritative if deletion fails.
        }
    }

    public void DeleteInvalidVault()
    {
        try { if (File.Exists(_vaultPath)) File.Delete(_vaultPath); } catch { }
    }

}
