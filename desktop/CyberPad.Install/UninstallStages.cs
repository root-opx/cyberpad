using System;
using System.IO;
using System.Text;

namespace CyberPad.Install
{
    public enum UninstallStage
    {
        /// <summary>Started from the install folder, no arguments: copy to temp and hand over.</summary>
        First,

        /// <summary>Started as <c>--stage2</c>: show the window and uninstall.</summary>
        Second,

        /// <summary>Anything else: do nothing.</summary>
        Invalid,
    }

    /// <summary>The two-stage start of <c>Uninstall.exe</c>. No path is ever passed between the stages.</summary>
    public static class UninstallStages
    {
        public const string Stage2Argument = "--stage2";
        public const string TempPrefix = "CyberPad-Uninstall-";
        public const string TempExtension = ".exe";
        public const int RandomBytes = 16;

        public static UninstallStage Parse(string[]? args)
        {
            if (args == null || args.Length == 0)
            {
                return UninstallStage.First;
            }

            return args.Length == 1 && string.Equals(args[0], Stage2Argument, StringComparison.Ordinal)
                ? UninstallStage.Second
                : UninstallStage.Invalid;
        }

        /// <summary><c>CyberPad-Uninstall-&lt;32 hex digits&gt;.exe</c> from random bytes.</summary>
        public static string TempCopyName(byte[] random)
        {
            if (random == null || random.Length != RandomBytes)
            {
                throw new ArgumentException("Exactly " + RandomBytes + " random bytes are required.", nameof(random));
            }

            var text = new StringBuilder(TempPrefix, TempPrefix.Length + RandomBytes * 2 + TempExtension.Length);
            foreach (byte b in random)
            {
                text.Append("0123456789abcdef"[b >> 4]).Append("0123456789abcdef"[b & 15]);
            }

            return text.Append(TempExtension).ToString();
        }

        /// <summary>The full path of a new temp copy: always directly inside <paramref name="tempFolder"/>.</summary>
        public static string TempCopyPath(string tempFolder, byte[] random) =>
            Path.Combine(tempFolder, TempCopyName(random));
    }
}
