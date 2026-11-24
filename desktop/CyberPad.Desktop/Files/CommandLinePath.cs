using System.Security;

namespace CyberPad.Desktop.Files;

/// <summary>Turns the single command-line argument into a validated full path.</summary>
internal static class CommandLinePath
{
    /// <summary>
    /// A relative argument is resolved against <paramref name="baseDirectory"/> (the folder CyberPad was started from)
    /// and the result goes through <see cref="FilePathPolicy.TryNormalize"/> like any other path. Absolute arguments
    /// are passed through unchanged.
    /// </summary>
    public static bool TryResolve(string? arg, string baseDirectory, out string fullPath, out LinkFormat format)
    {
        fullPath = string.Empty;
        format = default;
        if (string.IsNullOrEmpty(arg)) return false;

        var candidate = arg;
        if (!Path.IsPathFullyQualified(arg))
        {
            foreach (var c in arg)
            {
                if (char.IsControl(c)) return false;
            }
            if (string.IsNullOrEmpty(baseDirectory) || !Path.IsPathFullyQualified(baseDirectory)) return false;
            try
            {
                candidate = Path.GetFullPath(arg, baseDirectory);
            }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException or SecurityException)
            {
                return false;
            }
        }
        return FilePathPolicy.TryNormalize(candidate, out fullPath, out format);
    }
}
