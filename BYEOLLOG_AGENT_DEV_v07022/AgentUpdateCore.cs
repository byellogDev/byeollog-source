using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HurogiCollector;

internal static class AgentUpdateTrust
{
    internal const int UpdaterProtocol = 1;
    internal const string CatalogUrl = "https://byeollog.com/agent-updates/stable/win-x64.json";
    internal const string LegacyKeyId = "rsa3072-69d28a1ef55f02f2";
    internal const string PrimaryKeyId = "rsa3072-cc1fb719f3a63774";
    internal const string RecoveryKeyId = "rsa3072-c40c6be5c45ab4d3";
    internal const string KeyId = PrimaryKeyId;
    internal const string SignatureAlgorithm = "rsa-pss-sha256";

    private const string LegacySelfTestMessage = "byeollog-agent-update-trust-self-test-v1";
    private const string LegacySelfTestSignatureBase64 =
        "qRy1+o86peRFx5frAy/MMxtJ/brVdHVShhZWDo5uNnYTeRicU2lIauopO0fe5p4qHJtfM/F0LEJS4mAUbT/FfsDKLYj0nyN171vqFbzM+u2GUfQsg+WUur+zmqnDy+MRFr1WhADTTbkSDAv2SgYlQxYMja1cKSYCRjvt1a1hEWb3hKfPMBkZFIxUKNDzxz0CUs78AZsRdqAffeZUZNJznGY37nvtiX5fZCvShX35PP9EENrarWlHtpCHVbCwaiOmEdLK+7990WQpdTvW52Gj8HJNMHguLoJyEnR8SPmZxbuDjbarZps1NK+5zFX/WY3Wd5fOk1q569CzF4cF15mzFW8bwxR4eddPG/PEolGHcWHY3WZKLa2U0WFgvh9RObnxYr2pcW/JVzUCGDOroSE1Q0iNdctO09LR5OM3cQdVW9w/eEQR3btgImgweaD78y/Tp+vjLlGwasX6LjunZijDkPfkTLfZF7j39oI9Bk99umyKQrFHINRBWHKmLMgonCHi";

    private const string LegacyModulusBase64 =
        "x6K025JgRqRHPFNuNfT4iiDymXrMb0VYWS7zTF4/wvTItmCABNDtiDwkI58KL+BszRPSBYI2k/OZc7GkwKQc92ARBAhhmjCEQhVRUXN3Kq5x3UXGiHL7oyb+F4/raC04f0ZzOnaJLzXd9DPf2La1oLIdFla6ToAwHVKpGv92tS+zSse5yu9i028WGKzlyTxZLkci8XiPFiaSBaYtsMJDVkBZmA48fFgxKjMfxtxazcGqcqAwSZDDPQ8BTMl4CGwtjg4gUGVWC8zVz+hkmV7WARuugJO343k9Ty7rU2oLq5wOInH8KGz//Oakr8bqduINlc6ddNtLRF/W0hQup5/ieUQupYwEenNdcKdRneRmnlxJQeAgz9Ez4U9PoQRspPclMCVOApCnv52/xGs+IRntoanofaJfyva4oa3sWWtFjrFTIW6tt464LgT7BI+eidEhUYSsR0Yd2Zop+d5KVutXLA/6exK03ccf3TvXqRdq4AH1PvprY5+dirWaBfwUOSdR";
    private const string ExponentBase64 = "AQAB";

    private const string PrimaryModulusBase64 =
        "xh6UD7hSfTLd9lWkerCb3yrGY9hAur3s8maFJYlcdsCZu+YSUsGkKFonG8RPHXDeabmXXrsAAxl9oacxFdtfpxq0zAvyWXbv7VdKB9izi0kooBAPTs1kUe87pcbvTunj/7uPfTolcnT7wC5mlzoxlZQ8H+dyCWha1bKwOJYIgEPPbSqx+1lc8baeO4PTUZ3Cl/jCVX1VlqgKLFvaPjTOLiUtS6e4Wyv1S9r83N7EdHA8xiSKc89e+GEUHJzWjKdgCfmGPtNN4JJHH+6j+/npmSEdQb8SQ9/Bj3N2ETiM+hBL4mJko9mXyNCZG9ZlY5U1kPk9DBnmb2biNuF7xvhJ2UjpdxBeFJ20DJgtWCM30o/x8mNVViGEErvEIlmZKatPShB+ExAhrpx9cJRoccWtpMjvbejLbv6gKehfYhZ+Xc0q6e3/D+/MWGcCiVNYhBidoHB8TCvsSwza0/+ZmB1z6hBrKnJIVksUYTvOZzcNeqPmC7vah0USWrMyua/mQpxh";
    private const string PrimarySelfTestMessage = "byeollog-agent-update-trust-self-test-v2:rsa3072-cc1fb719f3a63774";
    private const string PrimarySelfTestSignatureBase64 =
        "iMIDGCqZQzPWJ9xyc8xkXhzhEUjAxl7mwar3ghWoEErVoEausWLrHDuaTBWBlO6iAeufXEBeRizw/jzvBzPRsGS6l8P5D5yYi7Y7G3OMtt5mOp5tZZlTKfkSSdqIf3DiiQk+1CYCz1xcxCrADtcpS6iOT9mg+ZZJrMTmCkPgIOge8Qx+JJly4cd+v6h595kWAPO39C12EuobBiIuSChD/biuk9n/HQ0k55nxNnAxUV0w3IkQ0wbI7zsltvzf+IDlLrDIGbcezBSNrZ3CRtXjX3e2zS1E/ytEaxLk4pwGZobRuddMTijA+LOAKb6gnSUvBfQpF8cQQvQCftXgIRsl9SMF5FtM0mu1bMtYKtq57vxtmJG0LG68dWlZVo5KHuz/bZ1gunu9FILA3rWb2/tZnHMh3vs8AZxk80U4bBF+71+IU7W96803hXgMPaTFWNWVpzztn18qPt4phds/rzKdeG+aQ0tgl4ozXamGDsIJlrNZ2WkoUI+HuRRpPvJplE9T";

    private const string RecoveryModulusBase64 =
        "zdWDoX/6wL5ngcQtbzvv4+IO8CYowEC6i8gY2SIAJ1UJOIRcvLIG61mymPO6Jfas7aJdZJlwMsXAh9//meKbYkWO4EpMIhsH+NT6qHOl2lCyfBhAVuqKEPIS6c9xHTB3T1h25jpGaCE5vXEVh6yz8XZFomdpqQM7xNK4/NbvK0zARQy3sx0GSGsGRkr99vFSz2KF1oNl9KxUZK9t27tmoKgWbGyYAoDdBcYVpDqjuv1VLm9yI06EilPn09/0Rpx6+Cv3OEp2yCyQJNZL+vvWREOvZ0nybc7IM5+UL12yD4V8BIo+cFdWwUX+BSG4Hqn+dhFBNnOwaw25QPP1nmze7+L079vrMxhuuptlnIZIpmD8fscfUK6rYi6rNa3IXUt41JbvBLE2fofNELN/EIN5du4b9hOASITaXQFG3K0V0O8jV1qOj4y2Hkz8aANXqi4yYkS9jnIeQFeS4wgqd8KQDwKMaIiSd8jwunJpLmct83PpnMyFMbngq9GhpO9qaaA5";
    private const string RecoverySelfTestMessage = "byeollog-agent-update-trust-self-test-v2:rsa3072-c40c6be5c45ab4d3";
    private const string RecoverySelfTestSignatureBase64 =
        "JjkFVGrU+pCi3D4pa6j04N7bQ8UM607NVa8CmD1PjbOaWa988wHvR5IOBKlNl1gNvopVm7cen5gnn3Vv/x1ZK2ct0dsg9dn4i7uw4taEVtwC+jOH8ik74MfxDchmmlrEGSP4Ap/iZScAfoyC57kCP7mPAaF7uIwqw8lANO30/JU38Y1xJR13ojkNB9N7CvYQhcVm2HJJyxbamfLKnZMStDBfAyGEZYkHtaG1VJyEgCDMr5LgLmf3kY8lmAP13RMIZfUrcO9c7sV9J1tVIDAow3ZbhFh8VQaLxoxHSQBlW6vgm6rJzbUceF+iPe8OOVM/e+1qlDhUKF28wol+TNECD6NPMwe5lwOM+iBc4yGXAdIxSYhD2uPjmcybENKdZR1dRAlbY03gknPZS/YrsTSaLoof0ZG8QWQRkmXCh/3EOcGqFiBKknLwV2+YCFoR1hR+wCSZhjMeMCis26vPOX3F3JhwZoT7DubFhZ0yNcJ0oShF/89dCMGIuQ615aRmGuoU";

    internal static RSA CreatePinnedPublicKey(string keyId)
    {
        var modulus = keyId switch
        {
            LegacyKeyId => LegacyModulusBase64,
            PrimaryKeyId => PrimaryModulusBase64,
            RecoveryKeyId => RecoveryModulusBase64,
            _ => throw new CryptographicException("update_catalog_key")
        };
        var rsa = RSA.Create();
        rsa.ImportParameters(new RSAParameters
        {
            Modulus = Convert.FromBase64String(modulus),
            Exponent = Convert.FromBase64String(ExponentBase64)
        });
        return rsa;
    }

    internal static RSA CreatePinnedPublicKey() => CreatePinnedPublicKey(PrimaryKeyId);

    internal static bool VerifyPinnedKeySelfTest()
    {
        return VerifyPinnedKeySelfTest(LegacyKeyId, LegacySelfTestMessage, LegacySelfTestSignatureBase64) &&
               VerifyPinnedKeySelfTest(PrimaryKeyId, PrimarySelfTestMessage, PrimarySelfTestSignatureBase64) &&
               VerifyPinnedKeySelfTest(RecoveryKeyId, RecoverySelfTestMessage, RecoverySelfTestSignatureBase64);
    }

    private static bool VerifyPinnedKeySelfTest(string keyId, string message, string signatureBase64)
    {
        using var rsa = CreatePinnedPublicKey(keyId);
        return rsa.KeySize == 3072 && rsa.VerifyData(
            Encoding.ASCII.GetBytes(message),
            Convert.FromBase64String(signatureBase64),
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pss);
    }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class AgentUpdateEnvelope
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; }

    [JsonPropertyName("payload")]
    public string Payload { get; init; } = "";

    [JsonPropertyName("signature")]
    public AgentUpdateSignature Signature { get; init; } = new();
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class AgentUpdateSignature
{
    [JsonPropertyName("algorithm")]
    public string Algorithm { get; init; } = "";

    [JsonPropertyName("keyId")]
    public string KeyId { get; init; } = "";

    [JsonPropertyName("value")]
    public string Value { get; init; } = "";
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class AgentUpdatePayload
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; }

    [JsonPropertyName("product")]
    public string Product { get; init; } = "";

    [JsonPropertyName("channel")]
    public string Channel { get; init; } = "";

    [JsonPropertyName("platform")]
    public string Platform { get; init; } = "";

    [JsonPropertyName("releaseSequence")]
    public long ReleaseSequence { get; init; }

    [JsonPropertyName("version")]
    public string Version { get; init; } = "";

    [JsonPropertyName("displayVersion")]
    public string DisplayVersion { get; init; } = "";

    [JsonPropertyName("publishedAtUtc")]
    public DateTimeOffset PublishedAtUtc { get; init; }

    [JsonPropertyName("expiresAtUtc")]
    public DateTimeOffset ExpiresAtUtc { get; init; }

    [JsonPropertyName("minimumUpdaterProtocol")]
    public int MinimumUpdaterProtocol { get; init; }

    [JsonPropertyName("mandatory")]
    public bool Mandatory { get; init; }

    [JsonPropertyName("package")]
    public AgentUpdatePackage Package { get; init; } = new();

    [JsonPropertyName("summary")]
    public string Summary { get; init; } = "";
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class AgentUpdatePackage
{
    [JsonPropertyName("url")]
    public string Url { get; init; } = "";

    [JsonPropertyName("byteSize")]
    public long ByteSize { get; init; }

    [JsonPropertyName("sha256")]
    public string Sha256 { get; init; } = "";

    [JsonPropertyName("innerManifestSha256")]
    public string InnerManifestSha256 { get; init; } = "";
}

internal sealed record VerifiedAgentUpdate(AgentUpdatePayload Payload, byte[] PayloadBytes);

internal static class AgentUpdateVerifier
{
    private const int MaximumCatalogBytes = 64 * 1024;
    private const long MaximumPackageBytes = 256L * 1024 * 1024;
    internal const long MaximumReleaseSequence = 9_999_999_999L;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions StrictJson = new()
    {
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        AllowTrailingCommas = false
    };

    internal static VerifiedAgentUpdate VerifyCatalog(
        ReadOnlySpan<byte> catalogBytes,
        RSA trustedPublicKey,
        DateTimeOffset nowUtc)
        => VerifyCatalog(catalogBytes, trustedPublicKey, nowUtc, AgentUpdateTrust.KeyId);

    internal static VerifiedAgentUpdate VerifyCatalogWithPinnedTrust(
        ReadOnlySpan<byte> catalogBytes,
        DateTimeOffset nowUtc)
    {
        var keyId = ReadCatalogKeyId(catalogBytes);
        using var trustedPublicKey = AgentUpdateTrust.CreatePinnedPublicKey(keyId);
        return VerifyCatalog(catalogBytes, trustedPublicKey, nowUtc, keyId);
    }

    internal static VerifiedAgentUpdate VerifyCatalog(
        ReadOnlySpan<byte> catalogBytes,
        RSA trustedPublicKey,
        DateTimeOffset nowUtc,
        string expectedKeyId)
    {
        if (catalogBytes.Length is <= 0 or > MaximumCatalogBytes)
            throw new InvalidDataException("update_catalog_size");

        AgentUpdateEnvelope envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<AgentUpdateEnvelope>(catalogBytes, StrictJson)
                ?? throw new InvalidDataException("update_catalog_empty");
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("update_catalog_json", ex);
        }

        if (envelope.SchemaVersion != 1 ||
            !string.Equals(envelope.Signature.Algorithm, AgentUpdateTrust.SignatureAlgorithm, StringComparison.Ordinal) ||
            !string.Equals(envelope.Signature.KeyId, expectedKeyId, StringComparison.Ordinal))
        {
            throw new InvalidDataException("update_catalog_identity");
        }

        byte[] payloadBytes;
        byte[] signatureBytes;
        try
        {
            payloadBytes = Convert.FromBase64String(envelope.Payload);
            signatureBytes = Convert.FromBase64String(envelope.Signature.Value);
        }
        catch (FormatException ex)
        {
            throw new InvalidDataException("update_catalog_base64", ex);
        }

        if (payloadBytes.Length is <= 0 or > 32 * 1024 || signatureBytes.Length is < 256 or > 1024)
            throw new InvalidDataException("update_catalog_signature_shape");

        if (!trustedPublicKey.VerifyData(
                payloadBytes,
                signatureBytes,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pss))
        {
            throw new CryptographicException("update_catalog_signature");
        }

        AgentUpdatePayload payload;
        try
        {
            var json = StrictUtf8.GetString(payloadBytes);
            payload = JsonSerializer.Deserialize<AgentUpdatePayload>(json, StrictJson)
                ?? throw new InvalidDataException("update_payload_empty");
        }
        catch (DecoderFallbackException ex)
        {
            throw new InvalidDataException("update_payload_utf8", ex);
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("update_payload_json", ex);
        }

        ValidatePayload(payload, nowUtc);
        return new VerifiedAgentUpdate(payload, payloadBytes);
    }

    private static string ReadCatalogKeyId(ReadOnlySpan<byte> catalogBytes)
    {
        if (catalogBytes.Length is <= 0 or > MaximumCatalogBytes)
            throw new InvalidDataException("update_catalog_size");
        try
        {
            var envelope = JsonSerializer.Deserialize<AgentUpdateEnvelope>(catalogBytes, StrictJson)
                ?? throw new InvalidDataException("update_catalog_empty");
            if (envelope.SchemaVersion != 1 ||
                !string.Equals(envelope.Signature.Algorithm, AgentUpdateTrust.SignatureAlgorithm, StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(envelope.Signature.KeyId))
            {
                throw new InvalidDataException("update_catalog_identity");
            }
            return envelope.Signature.KeyId;
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("update_catalog_json", ex);
        }
    }

    internal static Version ParseVersion(string value, string errorCode)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            value.Length > 32 ||
            !System.Text.RegularExpressions.Regex.IsMatch(value, @"^\d+\.\d+\.\d+\.\d+$", System.Text.RegularExpressions.RegexOptions.CultureInvariant) ||
            !Version.TryParse(value, out var parsed))
        {
            throw new InvalidDataException(errorCode);
        }
        return parsed;
    }

    internal static bool IsNewer(string candidate, string current) =>
        ParseVersion(candidate, "update_candidate_version").CompareTo(
            ParseVersion(current, "update_current_version")) > 0;

    private static void ValidatePayload(AgentUpdatePayload payload, DateTimeOffset nowUtc)
    {
        if (payload.SchemaVersion != 1 ||
            !string.Equals(payload.Product, "byeollog-collector", StringComparison.Ordinal) ||
            !string.Equals(payload.Channel, "stable", StringComparison.Ordinal) ||
            !string.Equals(payload.Platform, "win-x64", StringComparison.Ordinal))
        {
            throw new InvalidDataException("update_payload_identity");
        }

        ParseVersion(payload.Version, "update_payload_version");
        if (payload.ReleaseSequence is <= 0 or > MaximumReleaseSequence ||
            payload.DisplayVersion.Length is <= 0 or > 96 ||
            payload.Summary.Length > 512 ||
            payload.MinimumUpdaterProtocol is <= 0 or > AgentUpdateTrust.UpdaterProtocol)
        {
            throw new InvalidDataException("update_payload_contract");
        }

        if (payload.PublishedAtUtc == default || payload.ExpiresAtUtc == default ||
            payload.PublishedAtUtc > nowUtc.AddMinutes(15) ||
            payload.ExpiresAtUtc <= nowUtc ||
            payload.ExpiresAtUtc <= payload.PublishedAtUtc ||
            payload.ExpiresAtUtc - payload.PublishedAtUtc > TimeSpan.FromDays(370))
        {
            throw new InvalidDataException("update_payload_time");
        }

        if (payload.Package.ByteSize is <= 0 or > MaximumPackageBytes ||
            !IsSha256(payload.Package.Sha256) ||
            !IsSha256(payload.Package.InnerManifestSha256))
        {
            throw new InvalidDataException("update_package_contract");
        }

        if (!Uri.TryCreate(payload.Package.Url, UriKind.Absolute, out var packageUri) ||
            !AgentUpdatePackageRedirectPolicy.IsValidInitialPackageUri(packageUri, payload.Version))
        {
            throw new InvalidDataException("update_package_url");
        }
    }

    internal static bool IsSha256(string value) =>
        value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
}

internal sealed record AgentUpdatePackageRedirectContext(
    Uri InitialUri,
    string Version,
    string EscapedPackageFileName);

internal static class AgentUpdatePackageRedirectPolicy
{
    internal const int MaximumRedirects = 2;
    private const string GithubHost = "github.com";
    private const string ReleaseAssetsHost = "release-assets.githubusercontent.com";

    internal static bool IsValidInitialPackageUri(Uri uri) =>
        uri.IsAbsoluteUri &&
        string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(uri.IdnHost, "byeollog.com", StringComparison.OrdinalIgnoreCase) &&
        uri.IsDefaultPort &&
        string.IsNullOrEmpty(uri.UserInfo) &&
        string.IsNullOrEmpty(uri.Query) &&
        string.IsNullOrEmpty(uri.Fragment) &&
        uri.AbsolutePath.StartsWith("/agent-updates/releases/", StringComparison.Ordinal) &&
        uri.AbsolutePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);

    internal static bool IsValidInitialPackageUri(Uri uri, string version)
    {
        if (!IsValidInitialPackageUri(uri)) return false;
        var escapedFileName = EscapedFileName(uri);
        return escapedFileName.Length > ".zip".Length &&
               string.Equals(
                   uri.AbsolutePath,
                   $"/agent-updates/releases/{version}/{escapedFileName}",
                   StringComparison.Ordinal);
    }

    internal static AgentUpdatePackageRedirectContext Create(Uri initialUri, string version)
    {
        AgentUpdateVerifier.ParseVersion(version, "update_package_redirect_version");
        if (!IsValidInitialPackageUri(initialUri, version))
            throw new InvalidDataException("update_package_url");

        var escapedFileName = EscapedFileName(initialUri);
        return new AgentUpdatePackageRedirectContext(initialUri, version, escapedFileName);
    }

    internal static Uri ResolveAndValidate(
        AgentUpdatePackageRedirectContext context,
        Uri currentUri,
        Uri location,
        int redirectNumber)
    {
        if (redirectNumber is < 1 or > MaximumRedirects)
            throw new InvalidDataException("update_package_redirect_limit");

        Uri nextUri;
        try
        {
            nextUri = location.IsAbsoluteUri ? location : new Uri(currentUri, location);
        }
        catch (UriFormatException ex)
        {
            throw new InvalidDataException("update_package_redirect_location", ex);
        }

        if (!IsSecureEndpoint(nextUri))
            throw new InvalidDataException("update_package_redirect_target");

        var isReleaseAsset = string.Equals(
            nextUri.IdnHost,
            ReleaseAssetsHost,
            StringComparison.OrdinalIgnoreCase);
        if (redirectNumber == 2)
        {
            if (!isReleaseAsset)
                throw new InvalidDataException("update_package_redirect_target");
            return nextUri;
        }

        if (isReleaseAsset) return nextUri;

        var exactGithubPath =
            $"/byellogDev/byeollog-releases/releases/download/agent-v{context.Version}/{context.EscapedPackageFileName}";
        if (!string.Equals(nextUri.IdnHost, GithubHost, StringComparison.OrdinalIgnoreCase) ||
            !string.IsNullOrEmpty(nextUri.Query) ||
            !string.Equals(nextUri.AbsolutePath, exactGithubPath, StringComparison.Ordinal))
        {
            throw new InvalidDataException("update_package_redirect_target");
        }
        return nextUri;
    }

    private static bool IsSecureEndpoint(Uri uri) =>
        uri.IsAbsoluteUri &&
        string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) &&
        uri.IsDefaultPort &&
        string.IsNullOrEmpty(uri.UserInfo) &&
        string.IsNullOrEmpty(uri.Fragment);

    private static string EscapedFileName(Uri uri)
    {
        var separator = uri.AbsolutePath.LastIndexOf('/');
        return separator >= 0 && separator < uri.AbsolutePath.Length - 1
            ? uri.AbsolutePath[(separator + 1)..]
            : "";
    }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class InstalledReleaseManifest
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; }

    [JsonPropertyName("product")]
    public string Product { get; init; } = "";

    [JsonPropertyName("version")]
    public string Version { get; init; } = "";

    [JsonPropertyName("platform")]
    public string Platform { get; init; } = "";

    [JsonPropertyName("packageLayout")]
    public string PackageLayout { get; init; } = "";

    [JsonPropertyName("generatedAtUtc")]
    public DateTimeOffset GeneratedAtUtc { get; init; }

    [JsonPropertyName("fileCount")]
    public int FileCount { get; init; }

    [JsonPropertyName("totalByteSize")]
    public long TotalByteSize { get; init; }

    [JsonPropertyName("authenticity")]
    public InstalledReleaseAuthenticity Authenticity { get; init; } = new();

    [JsonPropertyName("files")]
    public List<InstalledReleaseFile> Files { get; init; } = [];
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class InstalledReleaseAuthenticity
{
    [JsonPropertyName("mode")]
    public string Mode { get; init; } = "";

    [JsonPropertyName("scope")]
    public string Scope { get; init; } = "";

    [JsonPropertyName("signerThumbprint")]
    public string? SignerThumbprint { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class InstalledReleaseFile
{
    [JsonPropertyName("path")]
    public string Path { get; init; } = "";

    [JsonPropertyName("role")]
    public string Role { get; init; } = "";

    [JsonPropertyName("byteSize")]
    public long ByteSize { get; init; }

    [JsonPropertyName("sha256")]
    public string Sha256 { get; init; } = "";
}

internal static class AgentUpdatePackageInstaller
{
    private const string ManifestName = "release-manifest.json";
    private const string ChecksumsName = "SHA256SUMS.txt";
    private const int MaximumEntries = 64;
    private const long MaximumExpandedBytes = 1024L * 1024 * 1024;
    private static readonly HashSet<string> ProtocolV1FrozenInstallRootFiles = new(StringComparer.Ordinal)
    {
        "LAUNCH_BYEOLLOG.cmd",
        "Byeollog-Launcher.ps1",
        "Install-Byeollog.ps1",
        "ROLLBACK_LAST_VERSION.cmd",
        "VERIFY_INSTALL.cmd",
        "RESTORE_PREUPDATE_STATE.cmd",
        "CREATE_SUPPORT_BUNDLE.cmd",
        "RUN_REPLAY_CANDIDATE_CHECK.cmd",
        "Collect-SupportBundle.ps1"
    };
    private static readonly UTF8Encoding Utf8NoBom = new(false, true);
    private static readonly JsonSerializerOptions StrictJson = new()
    {
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        AllowTrailingCommas = false
    };

    internal static string InstallVerifiedPackage(
        string packagePath,
        AgentUpdatePayload signedPayload,
        string installRoot,
        string currentVersion,
        bool runPreflight)
    {
        var normalizedInstallRoot = Path.GetFullPath(installRoot).TrimEnd(Path.DirectorySeparatorChar);
        EnsureOrdinaryDirectory(normalizedInstallRoot, create: false, "update_install_root");
        var versionsRoot = Path.Combine(normalizedInstallRoot, "versions");
        EnsureOrdinaryDirectory(versionsRoot, create: true, "update_versions_root");

        if (!AgentUpdateVerifier.IsNewer(signedPayload.Version, currentVersion))
            throw new InvalidOperationException("update_not_newer");

        var packageInfo = new FileInfo(packagePath);
        if (!packageInfo.Exists || packageInfo.Length != signedPayload.Package.ByteSize ||
            packageInfo.Attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            throw new InvalidDataException("update_package_file");
        }

        using var packageStream = new FileStream(packagePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        var packageHash = HashStreamExactly(
            packageStream,
            signedPayload.Package.ByteSize,
            "update_package_file");
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(packageHash),
                Encoding.ASCII.GetBytes(signedPayload.Package.Sha256)))
        {
            throw new CryptographicException("update_package_sha256");
        }
        packageStream.Position = 0;

        using var archive = new ZipArchive(packageStream, ZipArchiveMode.Read, leaveOpen: true);
        if (archive.Entries.Count is <= 0 or > MaximumEntries)
            throw new InvalidDataException("update_zip_entry_count");

        var entries = new Dictionary<string, ZipArchiveEntry>(StringComparer.OrdinalIgnoreCase);
        long expandedBytes = 0;
        foreach (var entry in archive.Entries)
        {
            var name = entry.FullName;
            if (string.IsNullOrWhiteSpace(name) || name.Length > 128 ||
                name.IndexOfAny(['/', '\\']) >= 0 || name is "." or ".." ||
                name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                entry.Length <= 0 || entry.Length > 536_870_912 ||
                IsUnixSymbolicLink(entry.ExternalAttributes) ||
                !entries.TryAdd(name, entry))
            {
                throw new InvalidDataException("update_zip_entry");
            }
            expandedBytes = checked(expandedBytes + entry.Length);
            if (expandedBytes > MaximumExpandedBytes)
                throw new InvalidDataException("update_zip_expanded_size");
        }

        if (expandedBytes > Math.Max(packageInfo.Length * 100L, 128L * 1024 * 1024))
            throw new InvalidDataException("update_zip_ratio");

        if (!entries.TryGetValue(ManifestName, out var manifestEntry) || manifestEntry.Length > 4 * 1024 * 1024)
            throw new InvalidDataException("update_inner_manifest_missing");

        var manifestBytes = ReadEntryBytes(manifestEntry, 4 * 1024 * 1024);
        var manifestHash = Convert.ToHexString(SHA256.HashData(manifestBytes)).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(manifestHash),
                Encoding.ASCII.GetBytes(signedPayload.Package.InnerManifestSha256)))
        {
            throw new CryptographicException("update_inner_manifest_sha256");
        }

        InstalledReleaseManifest manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<InstalledReleaseManifest>(Utf8NoBom.GetString(manifestBytes), StrictJson)
                ?? throw new InvalidDataException("update_inner_manifest_empty");
        }
        catch (Exception ex) when (ex is JsonException or DecoderFallbackException)
        {
            throw new InvalidDataException("update_inner_manifest_json", ex);
        }

        ValidateManifest(manifest, signedPayload, entries, normalizedInstallRoot);
        VerifyEveryManifestFile(manifest, entries);

        var target = GetContainedVersionPath(versionsRoot, signedPayload.Version);
        if (Directory.Exists(target))
        {
            EnsureOrdinaryDirectory(target, create: false, "update_existing_target");
            VerifyInstalledTarget(target, manifest);
        }
        else
        {
            var staging = Path.Combine(versionsRoot, ".staging-update-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(staging);
            try
            {
                // Updater protocol v1 stages version-scoped app binaries only. The signed
                // install_root files are verified and allowlisted below, but the live launcher
                // remains frozen; replacing it requires a future protocol and installer flow.
                foreach (var file in manifest.Files.Where(static item => item.Role == "app"))
                {
                    var entry = entries[file.Path];
                    var destination = Path.Combine(staging, file.Path);
                    ExtractEntryVerified(entry, destination, file);
                }
                File.WriteAllBytes(Path.Combine(staging, ManifestName), manifestBytes);
                VerifyInstalledTarget(staging, manifest);
                if (runPreflight)
                    RunPreflight(Path.Combine(staging, "byeollog.exe"), staging, signedPayload.Version);
                Directory.Move(staging, target);
            }
            catch
            {
                TryDeleteOwnedStaging(staging, versionsRoot);
                throw;
            }
        }

        var installedCurrent = ReadPointerVersion(Path.Combine(normalizedInstallRoot, "current.json"));
        if (!string.Equals(installedCurrent, currentVersion, StringComparison.Ordinal))
            throw new InvalidOperationException("update_current_pointer_changed");

        WritePointerAtomic(Path.Combine(normalizedInstallRoot, "previous.json"), currentVersion);
        WritePointerAtomic(Path.Combine(normalizedInstallRoot, "current.json"), signedPayload.Version);
        return signedPayload.Version;
    }

    private static void ValidateManifest(
        InstalledReleaseManifest manifest,
        AgentUpdatePayload signedPayload,
        IReadOnlyDictionary<string, ZipArchiveEntry> entries,
        string installRoot)
    {
        if (manifest.SchemaVersion != 2 ||
            manifest.Product != "byeollog-collector" ||
            manifest.Version != signedPayload.Version ||
            manifest.Platform != "win-x64" ||
            manifest.PackageLayout != "flat_v1" ||
            manifest.GeneratedAtUtc == default ||
            manifest.FileCount != manifest.Files.Count ||
            manifest.Files.Count is < 1 or > 62 ||
            manifest.TotalByteSize != manifest.Files.Sum(static item => item.ByteSize) ||
            manifest.Authenticity.Mode != "trusted_channel_internal" ||
            manifest.Authenticity.Scope != "package_integrity_only" ||
            !string.IsNullOrEmpty(manifest.Authenticity.SignerThumbprint))
        {
            throw new InvalidDataException("update_inner_manifest_identity");
        }

        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in manifest.Files)
        {
            if (string.IsNullOrWhiteSpace(file.Path) || file.Path.Length > 128 ||
                file.Path.IndexOfAny(['/', '\\']) >= 0 || file.Path is "." or ".." ||
                !names.Add(file.Path) ||
                file.Role is not ("app" or "install_root" or "package_tool" or "documentation") ||
                file.Role == "install_root" && !ProtocolV1FrozenInstallRootFiles.Contains(file.Path) ||
                file.ByteSize <= 0 || file.ByteSize > 536_870_912 ||
                !AgentUpdateVerifier.IsSha256(file.Sha256) ||
                !entries.ContainsKey(file.Path))
            {
                throw new InvalidDataException("update_inner_manifest_file");
            }
        }

        var appFiles = manifest.Files.Where(static item => item.Role == "app").ToArray();
        if (appFiles.Length is < 1 or > 2 ||
            !appFiles.Any(static item => item.Path == "byeollog.exe") ||
            appFiles.Any(static item => item.Path is not ("byeollog.exe" or "WebView2Loader.dll")))
        {
            throw new InvalidDataException("update_inner_manifest_app_files");
        }

        // Protocol v1 deliberately freezes the managed-install launcher and
        // recovery tools. A signed future package must carry the exact same
        // nine root files and bytes; otherwise a manual bootstrap/protocol
        // upgrade is required instead of silently ignoring launcher changes.
        var installRootFiles = manifest.Files.Where(static item => item.Role == "install_root").ToArray();
        var installRootNames = installRootFiles.Select(static item => item.Path).ToHashSet(StringComparer.Ordinal);
        if (!installRootNames.SetEquals(ProtocolV1FrozenInstallRootFiles))
            throw new InvalidDataException("update_install_root_file_set");
        foreach (var file in installRootFiles)
        {
            var installedPath = Path.Combine(installRoot, file.Path);
            var installedInfo = new FileInfo(installedPath);
            if (!installedInfo.Exists || installedInfo.Attributes.HasFlag(FileAttributes.ReparsePoint) ||
                installedInfo.Length != file.ByteSize)
                throw new InvalidDataException("update_install_root_changed");
            using var installedStream = installedInfo.Open(FileMode.Open, FileAccess.Read, FileShare.Read);
            var installedHash = HashStreamExactly(installedStream, file.ByteSize, "update_install_root_changed");
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(installedHash),
                    Encoding.ASCII.GetBytes(file.Sha256)))
                throw new CryptographicException("update_install_root_changed");
        }

        var expectedArchiveNames = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase)
        {
            ManifestName,
            ChecksumsName
        };
        if (entries.Keys.Any(name => !expectedArchiveNames.Contains(name)) ||
            expectedArchiveNames.Any(name => !entries.ContainsKey(name)))
        {
            throw new InvalidDataException("update_zip_file_set");
        }
    }

    private static void VerifyEveryManifestFile(
        InstalledReleaseManifest manifest,
        IReadOnlyDictionary<string, ZipArchiveEntry> entries)
    {
        foreach (var file in manifest.Files)
        {
            var entry = entries[file.Path];
            if (entry.Length != file.ByteSize)
                throw new InvalidDataException("update_zip_file_size");
            using var stream = entry.Open();
            var hash = HashStreamExactly(stream, file.ByteSize, "update_zip_file_size");
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(hash),
                    Encoding.ASCII.GetBytes(file.Sha256)))
            {
                throw new CryptographicException("update_zip_file_sha256");
            }
        }
    }

    private static void ExtractEntryVerified(ZipArchiveEntry entry, string destination, InstalledReleaseFile expected)
    {
        using var input = entry.Open();
        using var output = new FileStream(
            destination,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            128 * 1024,
            FileOptions.WriteThrough);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[128 * 1024];
        long total = 0;
        while (total < expected.ByteSize)
        {
            var read = input.Read(buffer, 0, (int)Math.Min(buffer.LongLength, expected.ByteSize - total));
            if (read == 0) throw new EndOfStreamException("update_extract_size");
            total = checked(total + read);
            hash.AppendData(buffer, 0, read);
            output.Write(buffer, 0, read);
        }
        if (input.ReadByte() != -1) throw new InvalidDataException("update_extract_size");
        output.Flush(flushToDisk: true);
        var actualHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        if (total != expected.ByteSize ||
            !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(actualHash),
                Encoding.ASCII.GetBytes(expected.Sha256)))
        {
            throw new CryptographicException("update_extract_sha256");
        }
    }

    private static void VerifyInstalledTarget(string root, InstalledReleaseManifest manifest)
    {
        EnsureOrdinaryDirectory(root, create: false, "update_installed_root");
        var expectedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ManifestName };
        foreach (var file in manifest.Files.Where(static item => item.Role == "app"))
        {
            expectedNames.Add(file.Path);
            var path = Path.Combine(root, file.Path);
            var info = new FileInfo(path);
            if (!info.Exists || info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.Length != file.ByteSize)
                throw new InvalidDataException("update_installed_file");
            using var stream = info.Open(FileMode.Open, FileAccess.Read, FileShare.Read);
            var hash = HashStreamExactly(stream, file.ByteSize, "update_installed_file");
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(hash),
                    Encoding.ASCII.GetBytes(file.Sha256)))
            {
                throw new CryptographicException("update_installed_sha256");
            }
        }

        var actual = Directory.EnumerateFileSystemEntries(root).Select(Path.GetFileName).ToArray();
        if (actual.Any(name => name is null || !expectedNames.Contains(name)) || actual.Length != expectedNames.Count)
            throw new InvalidDataException("update_installed_file_set");
    }

    private static byte[] ReadEntryBytes(ZipArchiveEntry entry, int maximumBytes)
    {
        if (entry.Length <= 0 || entry.Length > maximumBytes)
            throw new InvalidDataException("update_zip_small_entry_size");
        using var input = entry.Open();
        var bytes = new byte[checked((int)entry.Length)];
        var total = 0;
        while (total < bytes.Length)
        {
            var read = input.Read(bytes, total, bytes.Length - total);
            if (read == 0) throw new EndOfStreamException("update_zip_small_entry_truncated");
            total = checked(total + read);
        }
        if (input.ReadByte() != -1) throw new InvalidDataException("update_zip_small_entry_overflow");
        return bytes;
    }

    private static string HashStreamExactly(Stream input, long expectedBytes, string lengthErrorCode)
    {
        if (expectedBytes < 0) throw new InvalidDataException(lengthErrorCode);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[128 * 1024];
        long total = 0;
        while (total < expectedBytes)
        {
            var read = input.Read(buffer, 0, (int)Math.Min(buffer.LongLength, expectedBytes - total));
            if (read == 0) throw new EndOfStreamException(lengthErrorCode);
            total = checked(total + read);
            hash.AppendData(buffer, 0, read);
        }
        if (input.ReadByte() != -1) throw new InvalidDataException(lengthErrorCode);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static bool IsUnixSymbolicLink(int externalAttributes) =>
        ((externalAttributes >> 16) & 0xF000) == 0xA000;

    private static string GetContainedVersionPath(string versionsRoot, string version)
    {
        AgentUpdateVerifier.ParseVersion(version, "update_target_version");
        var root = Path.GetFullPath(versionsRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var target = Path.GetFullPath(Path.Combine(root, version));
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("update_target_path");
        return target;
    }

    private static void EnsureOrdinaryDirectory(string path, bool create, string errorCode)
    {
        if (create) Directory.CreateDirectory(path);
        var info = new DirectoryInfo(path);
        if (!info.Exists || info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException(errorCode);
    }

    internal static string ReadPointerVersion(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length is <= 0 or > 64 * 1024 || info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("update_pointer_file");
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        if (!document.RootElement.TryGetProperty("schemaVersion", out var schema) || schema.GetInt32() != 1 ||
            !document.RootElement.TryGetProperty("version", out var versionProperty))
            throw new InvalidDataException("update_pointer_json");
        var version = versionProperty.GetString() ?? "";
        AgentUpdateVerifier.ParseVersion(version, "update_pointer_version");
        return version;
    }

    private static void WritePointerAtomic(string path, string version)
    {
        AgentUpdateVerifier.ParseVersion(version, "update_write_pointer_version");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schemaVersion = 1,
            version,
            updatedAtUtc = DateTimeOffset.UtcNow.ToString("O")
        });
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        var backup = path + ".bak";
        try
        {
            using (var stream = new FileStream(
                       temporary,
                       FileMode.CreateNew,
                       FileAccess.Write,
                       FileShare.None,
                       4096,
                       FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            if (File.Exists(path))
            {
                File.Replace(temporary, path, backup, ignoreMetadataErrors: true);
                try { File.Delete(backup); } catch { }
            }
            else
            {
                File.Move(temporary, path);
            }
        }
        finally
        {
            try { File.Delete(temporary); } catch { }
        }
    }

    private static void RunPreflight(string executable, string workingDirectory, string expectedVersion)
    {
        AgentUpdateVerifier.ParseVersion(expectedVersion, "update_preflight_expected_version");
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add("--update-preflight");
        startInfo.ArgumentList.Add(expectedVersion);
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("update_preflight_start");
        if (!process.WaitForExit(30_000))
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw new TimeoutException("update_preflight_timeout");
        }
        if (process.ExitCode != 0) throw new InvalidOperationException("update_preflight_failed");
    }

    private static void TryDeleteOwnedStaging(string staging, string versionsRoot)
    {
        try
        {
            var root = Path.GetFullPath(versionsRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var target = Path.GetFullPath(staging);
            if (target.StartsWith(root, StringComparison.OrdinalIgnoreCase) &&
                Path.GetFileName(target).StartsWith(".staging-update-", StringComparison.Ordinal) &&
                Directory.Exists(target) &&
                !new DirectoryInfo(target).Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                Directory.Delete(target, recursive: true);
            }
        }
        catch { }
    }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed class AgentUpdateLocalState
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; } = 1;

    [JsonPropertyName("lastCheckAtUtc")]
    public DateTimeOffset? LastCheckAtUtc { get; init; }

    [JsonPropertyName("nextCheckAtUtc")]
    public DateTimeOffset? NextCheckAtUtc { get; init; }

    [JsonPropertyName("highestReleaseSequence")]
    public long HighestReleaseSequence { get; init; }

    [JsonPropertyName("lastStatus")]
    public string LastStatus { get; init; } = "never";

    [JsonPropertyName("lastErrorCode")]
    public string? LastErrorCode { get; init; }

    [JsonPropertyName("availableVersion")]
    public string? AvailableVersion { get; init; }

    [JsonPropertyName("blockedVersion")]
    public string? BlockedVersion { get; init; }
}

internal static class AgentUpdateRunner
{
    internal const int UpdateInstalledExitCode = 10;
    private const int MaximumCatalogBytes = 64 * 1024;
    private const long MaximumPackageBytes = 256L * 1024 * 1024;
    private static readonly JsonSerializerOptions StateJson = new()
    {
        PropertyNameCaseInsensitive = false,
        WriteIndented = true
    };

    internal static async Task<int> RunAsync(string currentVersion, CancellationToken cancellationToken = default)
    {
        try
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var installRoot = Path.GetFullPath(Path.Combine(localAppData, "Programs", "ByeollogCollector"));
            var currentPointer = Path.Combine(installRoot, "current.json");
            if (!File.Exists(currentPointer)) return 0;

            var updatesRoot = Path.Combine(localAppData, "ByeollogAgent", "updates");
            Directory.CreateDirectory(updatesRoot);
            if (new DirectoryInfo(updatesRoot).Attributes.HasFlag(FileAttributes.ReparsePoint)) return 0;

            var statePath = Path.Combine(updatesRoot, "update-state.json");
            var state = ReadState(statePath);
            var now = DateTimeOffset.UtcNow;
            // A managed launch starts this updater in a separate hidden process after the
            // current Agent is already running. Always check the tiny signed catalog once
            // per launch; the install lock prevents duplicate work and network failures
            // remain fail-open. NextCheckAtUtc is retained only for schema-v1 compatibility.

            Directory.CreateDirectory(installRoot);
            var lockPath = Path.Combine(installRoot, ".install.lock");
            using var installLock = await AcquireInstallLockAsync(
                lockPath,
                currentPointer,
                currentVersion,
                cancellationToken);
            if (installLock is null) return UpdateInstalledExitCode;

            // A legacy launcher can start its own updater at the same time as the
            // visible Agent. If that updater committed the pointer first, the visible
            // Agent must restart into it instead of opening the old UI once more.
            var installedPointerVersion = AgentUpdatePackageInstaller.ReadPointerVersion(currentPointer);
            if (AgentUpdateVerifier.IsNewer(installedPointerVersion, currentVersion))
                return UpdateInstalledExitCode;

            using var handler = new HttpClientHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = DecompressionMethods.None,
                UseCookies = false
            };
            using var client = new HttpClient(handler)
            {
                Timeout = Timeout.InfiniteTimeSpan
            };
            client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Byeollog-Agent-Updater", currentVersion));

            var catalogBytes = await DownloadSmallFileAsync(
                client,
                new Uri(AgentUpdateTrust.CatalogUrl),
                MaximumCatalogBytes,
                TimeSpan.FromSeconds(8),
                cancellationToken);
            var verified = AgentUpdateVerifier.VerifyCatalogWithPinnedTrust(catalogBytes, now);
            if (verified.Payload.ReleaseSequence < state.HighestReleaseSequence)
                throw new InvalidDataException("update_catalog_replay");

            if (IsBlockedCandidate(verified.Payload.Version, state.BlockedVersion))
            {
                WriteStateAtomic(statePath, new AgentUpdateLocalState
                {
                    LastCheckAtUtc = now,
                    NextCheckAtUtc = null,
                    HighestReleaseSequence = Math.Max(state.HighestReleaseSequence, verified.Payload.ReleaseSequence),
                    LastStatus = "blocked_after_rollback",
                    AvailableVersion = verified.Payload.Version,
                    BlockedVersion = state.BlockedVersion
                });
                return 0;
            }

            if (!AgentUpdateVerifier.IsNewer(verified.Payload.Version, currentVersion))
            {
                WriteStateAtomic(statePath, new AgentUpdateLocalState
                {
                    LastCheckAtUtc = now,
                    NextCheckAtUtc = null,
                    HighestReleaseSequence = Math.Max(state.HighestReleaseSequence, verified.Payload.ReleaseSequence),
                    LastStatus = "current",
                    AvailableVersion = verified.Payload.Version,
                    BlockedVersion = BlockedVersionAfterSuccessfulInstall(currentVersion, state.BlockedVersion)
                });
                return 0;
            }

            var packagePath = Path.Combine(
                updatesRoot,
                ".agent-update-" + Guid.NewGuid().ToString("N") + ".zip");
            var packageReady = false;
            try
            {
                await DownloadPackageAsync(
                    client,
                    new Uri(verified.Payload.Package.Url),
                    verified.Payload.Version,
                    packagePath,
                    verified.Payload.Package.ByteSize,
                    verified.Payload.Package.Sha256,
                    cancellationToken);
                packageReady = true;

                var installedVersion = AgentUpdatePackageInstaller.InstallVerifiedPackage(
                    packagePath,
                    verified.Payload,
                    installRoot,
                    currentVersion,
                    runPreflight: true);
                TryWritePostCommitState(statePath, new AgentUpdateLocalState
                {
                    LastCheckAtUtc = now,
                    NextCheckAtUtc = null,
                    HighestReleaseSequence = Math.Max(state.HighestReleaseSequence, verified.Payload.ReleaseSequence),
                    LastStatus = "installed_restart_required",
                    AvailableVersion = installedVersion,
                    BlockedVersion = BlockedVersionAfterSuccessfulInstall(installedVersion, state.BlockedVersion)
                });
            }
            finally
            {
                if (packageReady) TryDeleteFile(packagePath);
            }
            return UpdateInstalledExitCode;
        }
        catch (Exception ex)
        {
            TryRecordFailure(ex);
            return 0; // Update failures must never block the currently installed Agent.
        }
    }

    internal static bool IsBlockedCandidate(string candidateVersion, string? blockedVersion)
    {
        if (!IsValidStoredVersion(blockedVersion)) return false;
        try
        {
            AgentUpdateVerifier.ParseVersion(candidateVersion, "update_candidate_version");
            return string.Equals(candidateVersion, blockedVersion, StringComparison.Ordinal);
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    internal static string? BlockedVersionAfterSuccessfulInstall(
        string installedVersion,
        string? blockedVersion)
    {
        if (!IsValidStoredVersion(blockedVersion)) return null;
        return AgentUpdateVerifier.IsNewer(installedVersion, blockedVersion!) ? null : blockedVersion;
    }

    private static async Task<byte[]> DownloadSmallFileAsync(
        HttpClient client,
        Uri uri,
        int maximumBytes,
        TimeSpan timeout,
        CancellationToken outerToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(outerToken);
        timeoutSource.CancelAfter(timeout);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutSource.Token);
        if (response.StatusCode != HttpStatusCode.OK ||
            response.Headers.Location is not null ||
            response.Content.Headers.ContentLength is { } catalogLength && catalogLength > maximumBytes)
            throw new HttpRequestException("update_catalog_http");
        await using var input = await response.Content.ReadAsStreamAsync(timeoutSource.Token);
        using var output = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await input.ReadAsync(buffer, timeoutSource.Token);
            if (read == 0) break;
            if (output.Length + read > maximumBytes) throw new InvalidDataException("update_catalog_too_large");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    internal static async Task DownloadPackageAsync(
        HttpClient client,
        Uri uri,
        string version,
        string destination,
        long expectedBytes,
        string expectedSha256,
        CancellationToken outerToken)
    {
        if (expectedBytes is <= 0 or > MaximumPackageBytes) throw new InvalidDataException("update_download_size");
        if (File.Exists(destination) || Directory.Exists(destination))
            throw new IOException("update_download_destination_exists");
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(outerToken);
        timeoutSource.CancelAfter(TimeSpan.FromMinutes(15));
        using var response = await SendPackageRequestAsync(client, uri, version, timeoutSource.Token);
        if (response.StatusCode != HttpStatusCode.OK ||
            response.Headers.Location is not null ||
            response.Content.Headers.ContentLength is { } contentLength && contentLength != expectedBytes ||
            response.Content.Headers.ContentEncoding.Count > 0)
            throw new HttpRequestException("update_package_http");

        var ownsDestination = false;
        try
        {
            await using var input = await response.Content.ReadAsStreamAsync(timeoutSource.Token);
            await using var output = new FileStream(
                destination,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                128 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough);
            ownsDestination = true;
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[128 * 1024];
            long total = 0;
            while (true)
            {
                var boundedRead = (int)Math.Min(buffer.LongLength, checked(expectedBytes - total + 1));
                var read = await input.ReadAsync(buffer.AsMemory(0, boundedRead), timeoutSource.Token);
                if (read == 0) break;
                total = checked(total + read);
                if (total > expectedBytes || total > MaximumPackageBytes)
                    throw new InvalidDataException("update_download_overflow");
                hash.AppendData(buffer, 0, read);
                await output.WriteAsync(buffer.AsMemory(0, read), timeoutSource.Token);
            }
            await output.FlushAsync(timeoutSource.Token);
            output.Flush(flushToDisk: true);
            var actualHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            if (total != expectedBytes ||
                !CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(actualHash),
                    Encoding.ASCII.GetBytes(expectedSha256)))
            {
                throw new CryptographicException("update_download_sha256");
            }
        }
        catch
        {
            if (ownsDestination) TryDeleteFile(destination);
            throw;
        }
    }

    private static async Task<HttpResponseMessage> SendPackageRequestAsync(
        HttpClient client,
        Uri initialUri,
        string version,
        CancellationToken cancellationToken)
    {
        var context = AgentUpdatePackageRedirectPolicy.Create(initialUri, version);
        var currentUri = context.InitialUri;
        var visited = new HashSet<string>(StringComparer.Ordinal) { currentUri.AbsoluteUri };
        var redirectCount = 0;

        while (true)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, currentUri);
            var response = await client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            if (!IsRedirect(response.StatusCode)) return response;

            try
            {
                if (response.Headers.Location is null)
                    throw new HttpRequestException("update_package_http");
                if (redirectCount >= AgentUpdatePackageRedirectPolicy.MaximumRedirects)
                    throw new InvalidDataException("update_package_redirect_limit");

                var nextUri = AgentUpdatePackageRedirectPolicy.ResolveAndValidate(
                    context,
                    currentUri,
                    response.Headers.Location,
                    redirectCount + 1);
                if (!visited.Add(nextUri.AbsoluteUri))
                    throw new InvalidDataException("update_package_redirect_loop");

                redirectCount++;
                currentUri = nextUri;
            }
            catch
            {
                response.Dispose();
                throw;
            }
            response.Dispose();
        }
    }

    private static bool IsRedirect(HttpStatusCode statusCode) => statusCode is
        HttpStatusCode.MovedPermanently or
        HttpStatusCode.Redirect or
        HttpStatusCode.RedirectMethod or
        HttpStatusCode.TemporaryRedirect or
        HttpStatusCode.PermanentRedirect;

    private static FileStream? TryAcquireInstallLock(string path)
    {
        try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { return null; }
    }

    private static async Task<FileStream?> AcquireInstallLockAsync(
        string lockPath,
        string currentPointer,
        string currentVersion,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow.AddMinutes(15);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var installLock = TryAcquireInstallLock(lockPath);
            if (installLock is not null) return installLock;

            try
            {
                var pointerVersion = AgentUpdatePackageInstaller.ReadPointerVersion(currentPointer);
                if (AgentUpdateVerifier.IsNewer(pointerVersion, currentVersion)) return null;
            }
            catch
            {
                // The other updater may be atomically replacing the pointer. Retry
                // until it commits or releases the install lock.
            }

            if (DateTimeOffset.UtcNow >= deadline) throw new TimeoutException("update_install_lock_timeout");
            await Task.Delay(200, cancellationToken);
        }
    }

    private static AgentUpdateLocalState ReadState(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length is <= 0 or > 64 * 1024 || info.Attributes.HasFlag(FileAttributes.ReparsePoint))
                return new AgentUpdateLocalState();
            var state = JsonSerializer.Deserialize<AgentUpdateLocalState>(File.ReadAllBytes(path));
            if (state is not { SchemaVersion: 1 } ||
                state.HighestReleaseSequence is < 0 or > AgentUpdateVerifier.MaximumReleaseSequence)
            {
                return new AgentUpdateLocalState();
            }
            if (state.BlockedVersion is null || IsValidStoredVersion(state.BlockedVersion)) return state;
            return new AgentUpdateLocalState
            {
                LastCheckAtUtc = state.LastCheckAtUtc,
                NextCheckAtUtc = state.NextCheckAtUtc,
                HighestReleaseSequence = state.HighestReleaseSequence,
                LastStatus = state.LastStatus,
                LastErrorCode = state.LastErrorCode,
                AvailableVersion = state.AvailableVersion
            };
        }
        catch { return new AgentUpdateLocalState(); }
    }

    private static bool IsValidStoredVersion(string? value)
    {
        if (value is null) return false;
        try
        {
            AgentUpdateVerifier.ParseVersion(value, "update_state_blocked_version");
            return true;
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    private static void WriteStateAtomic(string path, AgentUpdateLocalState state)
    {
        if (state.HighestReleaseSequence is < 0 or > AgentUpdateVerifier.MaximumReleaseSequence ||
            state.BlockedVersion is not null && !IsValidStoredVersion(state.BlockedVersion))
        {
            throw new InvalidDataException("update_state_contract");
        }
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(state, StateJson);
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { TryDeleteFile(temporary); }
    }

    private static void TryWritePostCommitState(string path, AgentUpdateLocalState state)
    {
        // InstallVerifiedPackage returning means current.json already committed. update-state.json
        // is advisory scheduling/telemetry and must not turn that successful commit into a failure.
        try { WriteStateAtomic(path, state); }
        catch { }
    }

    private static void TryRecordFailure(Exception exception)
    {
        try
        {
            var root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "ByeollogAgent",
                "updates");
            Directory.CreateDirectory(root);
            var path = Path.Combine(root, "update-state.json");
            var previous = ReadState(path);
            var now = DateTimeOffset.UtcNow;
            WriteStateAtomic(path, new AgentUpdateLocalState
            {
                LastCheckAtUtc = now,
                NextCheckAtUtc = null,
                HighestReleaseSequence = previous.HighestReleaseSequence,
                LastStatus = "failed_kept_current",
                LastErrorCode = SafeErrorCode(exception),
                BlockedVersion = previous.BlockedVersion
            });
        }
        catch { }
    }

    private static string SafeErrorCode(Exception exception)
    {
        var value = exception.Message;
        if (value.Length is > 0 and <= 80 && value.All(static character =>
                char.IsAsciiLetterOrDigit(character) || character is '_' or '-'))
            return value;
        return exception.GetType().Name;
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }
}

internal static class AgentUpdatePreflight
{
    internal static int Run(string version, string expectedVersion)
    {
        try
        {
            AgentUpdateVerifier.ParseVersion(version, "update_preflight_version");
            AgentUpdateVerifier.ParseVersion(expectedVersion, "update_preflight_expected_version");
            if (!string.Equals(version, expectedVersion, StringComparison.Ordinal)) return 3;
            if (!AgentUpdateTrust.VerifyPinnedKeySelfTest()) return 2;
            return 0;
        }
        catch { return 1; }
    }
}
