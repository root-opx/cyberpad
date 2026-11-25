using System;
using System.Text;

namespace CyberPad.Install
{
    /// <summary>Builds the command strings written to the registry.</summary>
    public static class CommandLine
    {
        /// <summary>
        /// Quotes one argument so that the Windows argument parser (CommandLineToArgvW and the C runtime)
        /// reads it back unchanged: backslashes before a quote are doubled and the quote escaped, and
        /// trailing backslashes are doubled so they do not escape the closing quote.
        /// </summary>
        public static string Quote(string arg)
        {
            if (arg == null)
            {
                throw new ArgumentNullException(nameof(arg));
            }

            if (arg.IndexOf('\0') >= 0)
            {
                throw new ArgumentException("An argument cannot contain a NUL character.", nameof(arg));
            }

            var result = new StringBuilder(arg.Length + 2);
            result.Append('"');
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (c == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                }
                else
                {
                    result.Append('\\', backslashes);
                }

                backslashes = 0;
                result.Append(c);
            }

            result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }

        /// <summary><c>"&lt;folder&gt;\Uninstall.exe"</c>, for the uninstall entry.</summary>
        public static string UninstallCommand(string installDir) =>
            Quote(CheckedFolder(installDir) + "\\" + InstallLayout.UninstallerFileName);

        /// <summary><c>"&lt;folder&gt;\CyberPad.exe" "%1"</c>, for the "Open with" registration.</summary>
        public static string OpenCommand(string installDir) =>
            Quote(CheckedFolder(installDir) + "\\" + InstallLayout.AppFileName) + " \"%1\"";

        /// <summary>
        /// A folder going into a command string must be a full local path with no double quote (which a
        /// Windows path cannot contain) and no "%" (which Explorer would expand in the open command).
        /// </summary>
        private static string CheckedFolder(string installDir)
        {
            if (installDir == null)
            {
                throw new ArgumentNullException(nameof(installDir));
            }

            if (installDir.IndexOf('"') >= 0 || installDir.IndexOf('%') >= 0 || PathText.HasControlCharacter(installDir) ||
                !PathText.IsDriveAbsolute(installDir) || installDir[installDir.Length - 1] == '\\')
            {
                throw new ArgumentException("The install folder cannot be used in a command.", nameof(installDir));
            }

            return installDir;
        }
    }
}
