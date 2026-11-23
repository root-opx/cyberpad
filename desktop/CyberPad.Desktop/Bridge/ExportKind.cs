namespace CyberPad.Desktop.Bridge;

public enum ExportKind { Note, Backup, EncryptedBackup, IocCsv, IocMd }

public static class ExportKinds
{
    /// <summary>Parses the wire name sent by the page. Exact case, allow-list only.</summary>
    public static bool TryParse(string? wire, out ExportKind kind)
    {
        switch (wire)
        {
            case "note": kind = ExportKind.Note; return true;
            case "backup": kind = ExportKind.Backup; return true;
            case "encryptedBackup": kind = ExportKind.EncryptedBackup; return true;
            case "iocCsv": kind = ExportKind.IocCsv; return true;
            case "iocMd": kind = ExportKind.IocMd; return true;
            default: kind = default; return false;
        }
    }

    public static string Extension(ExportKind k) => k switch
    {
        ExportKind.Note => ".md",
        ExportKind.Backup => ".json",
        ExportKind.EncryptedBackup => ".json",
        ExportKind.IocCsv => ".csv",
        ExportKind.IocMd => ".md",
        _ => throw new ArgumentOutOfRangeException(nameof(k)),
    };

    public static string DialogFilter(ExportKind k) => k switch
    {
        ExportKind.Note => "Markdown (*.md)|*.md",
        ExportKind.Backup => "JSON backup (*.json)|*.json",
        ExportKind.EncryptedBackup => "JSON backup (*.json)|*.json",
        ExportKind.IocCsv => "CSV (*.csv)|*.csv",
        ExportKind.IocMd => "Markdown (*.md)|*.md",
        _ => throw new ArgumentOutOfRangeException(nameof(k)),
    };
}
