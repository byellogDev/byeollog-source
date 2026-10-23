using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HurogiCollector;

internal sealed record VNextRememberedSession(
    string RefreshToken,
    string WorkspaceId,
    Guid UserId,
    string Email,
    DateTimeOffset SavedAt);

/// <summary>
/// Persists only the Supabase refresh token and its pinned automation identity.
/// The payload is encrypted with Windows DPAPI for the current Windows user;
/// access tokens and account passwords are never written to disk.
/// </summary>
internal sealed class VNextSessionVault
{
    private const int MaximumProtectedBytes = 64 * 1024;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes(
        "byeollog.offsl.automation.refresh-token.v1");
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly string _directory;
    private readonly string _vaultPath;
    private readonly string _tombstonePath;

    public VNextSessionVault(string rootPath)
    {
        if (string.IsNullOrWhiteSpace(rootPath))
            throw new ArgumentException("세션 저장 경로가 필요합니다.", nameof(rootPath));
        _directory = Path.Combine(Path.GetFullPath(rootPath), "vnext-session");
        _vaultPath = Path.Combine(_directory, "refresh-token.v1.dpapi");
        _tombstonePath = Path.Combine(_directory, "disconnect.v1");
    }

    public bool TryRead(out VNextRememberedSession remembered)
    {
        remembered = default!;
        try
        {
            if (File.Exists(_tombstonePath) || !File.Exists(_vaultPath)) return false;
            var protectedBytes = File.ReadAllBytes(_vaultPath);
            if (protectedBytes.Length is < 1 or > MaximumProtectedBytes)
            {
                DeleteInvalidVault();
                return false;
            }

            var plainBytes = ProtectedData.Unprotect(
                protectedBytes,
                Entropy,
                DataProtectionScope.CurrentUser);
            try
            {
                var candidate = JsonSerializer.Deserialize<VNextRememberedSession>(plainBytes, Json);
                if (!IsValid(candidate))
                {
                    DeleteInvalidVault();
                    return false;
                }
                remembered = candidate!;
                return true;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plainBytes);
            }
        }
        catch
        {
            DeleteInvalidVault();
            return false;
        }
    }

    public void ApplyLoginPreference(VNextRememberedSession? remembered, bool autoLogin)
    {
        if (autoLogin) Save(remembered ?? throw new ArgumentNullException(nameof(remembered)));
        else MarkDisconnectedAndDelete();
    }

    public void Save(VNextRememberedSession remembered)
    {
        if (!IsValid(remembered))
            throw new InvalidOperationException("저장할 방송 자동화 세션 정보가 올바르지 않습니다.");

        Directory.CreateDirectory(_directory);
        var plainBytes = JsonSerializer.SerializeToUtf8Bytes(remembered, Json);
        byte[]? protectedBytes = null;
        var temporaryPath = _vaultPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            protectedBytes = ProtectedData.Protect(
                plainBytes,
                Entropy,
                DataProtectionScope.CurrentUser);
            if (protectedBytes.Length > MaximumProtectedBytes)
                throw new InvalidOperationException("방송 자동화 세션 저장값이 제한을 초과했습니다.");
            File.WriteAllBytes(temporaryPath, protectedBytes);
            File.Move(temporaryPath, _vaultPath, overwrite: true);

            // Only a successful new login/recovery clears an explicit disconnect.
            if (File.Exists(_tombstonePath)) File.Delete(_tombstonePath);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plainBytes);
            if (protectedBytes is not null) CryptographicOperations.ZeroMemory(protectedBytes);
            try { if (File.Exists(temporaryPath)) File.Delete(temporaryPath); } catch { }
        }
    }

    public void MarkDisconnectedAndDelete()
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

    private static bool IsValid(VNextRememberedSession? remembered) =>
        remembered is not null
        // Refresh tokens are opaque, not JWTs. Supabase can issue 12-character
        // tokens; authentication/identity validation belongs to the server.
        && !string.IsNullOrWhiteSpace(remembered.RefreshToken)
        && remembered.RefreshToken.Length <= 16_384
        && !remembered.RefreshToken.Any(c => char.IsWhiteSpace(c) || char.IsControl(c))
        && Guid.TryParseExact(remembered.WorkspaceId, "D", out _)
        && remembered.UserId != Guid.Empty
        && remembered.Email.Length <= 320
        && remembered.SavedAt <= DateTimeOffset.UtcNow.AddMinutes(5);
}
