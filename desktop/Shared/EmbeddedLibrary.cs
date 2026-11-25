using System;
using System.IO;
using System.Reflection;

namespace CyberPad.Install.UI
{
    /// <summary>
    /// Setup and Uninstall are each a single file: CyberPad.Install.dll is embedded in the exe and loaded from
    /// there. Register must run before any type of the library is used, so it is called first in Main, and
    /// the rest of the program runs in a separate method.
    /// </summary>
    internal static class EmbeddedLibrary
    {
        private const string LibraryName = "CyberPad.Install";

        public static void Register()
        {
            AppDomain.CurrentDomain.AssemblyResolve += (sender, args) =>
            {
                if (!string.Equals(new AssemblyName(args.Name).Name, LibraryName, StringComparison.Ordinal))
                {
                    return null;
                }

                Assembly self = Assembly.GetExecutingAssembly();
                using (Stream? stream = self.GetManifestResourceStream(LibraryName + ".dll"))
                {
                    if (stream == null)
                    {
                        return null;
                    }

                    var bytes = new byte[stream.Length];
                    int read = 0;
                    while (read < bytes.Length)
                    {
                        int n = stream.Read(bytes, read, bytes.Length - read);
                        if (n <= 0)
                        {
                            return null;
                        }

                        read += n;
                    }

                    return Assembly.Load(bytes);
                }
            };
        }
    }
}
