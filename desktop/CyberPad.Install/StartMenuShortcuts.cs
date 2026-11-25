using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace CyberPad.Install
{
    /// <summary>
    /// The real <see cref="IShortcuts"/>: <c>CyberPad.lnk</c> in the user's Start menu Programs folder,
    /// written through the shell's COM ShellLink object (no shell command). Never exercised by the tests.
    /// </summary>
    public sealed class StartMenuShortcuts : IShortcuts
    {
        private const int MaxPath = 260;
        private const int StgmRead = 0;
        private const uint SlgpRawPath = 0x4;

        public static string ShortcutPath =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), InstallLayout.DisplayName + ".lnk");

        public ShortcutInfo? TryRead()
        {
            string path = ShortcutPath;
            if (!File.Exists(path))
            {
                return null;
            }

            return WithShellLink(link =>
            {
                ((IPersistFile)link).Load(path, StgmRead);
                var target = new StringBuilder(MaxPath);
                link.GetPath(target, target.Capacity, IntPtr.Zero, SlgpRawPath);
                var workingDirectory = new StringBuilder(MaxPath);
                link.GetWorkingDirectory(workingDirectory, workingDirectory.Capacity);
                var icon = new StringBuilder(MaxPath);
                link.GetIconLocation(icon, icon.Capacity, out _);
                return new ShortcutInfo(target.ToString(), workingDirectory.ToString(), icon.ToString());
            });
        }

        public void Create(ShortcutInfo shortcut)
        {
            if (shortcut == null)
            {
                throw new ArgumentNullException(nameof(shortcut));
            }

            string path = ShortcutPath;
            WithShellLink(link =>
            {
                link.SetPath(shortcut.TargetPath);
                link.SetWorkingDirectory(shortcut.WorkingDirectory);
                link.SetIconLocation(shortcut.IconPath, 0);
                link.SetDescription(InstallLayout.DisplayName);
                ((IPersistFile)link).Save(path, true);
                return true;
            });
        }

        public void Delete()
        {
            string path = ShortcutPath;
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path); // deletes the .lnk file (or a link in its place) itself, never a target
                }
            }
            catch (Exception ex) when (ex is ArgumentException || ex is NotSupportedException)
            {
                throw new IOException("The Start menu shortcut could not be deleted.", ex);
            }
        }

        /// <summary>
        /// Runs <paramref name="use"/> on a new ShellLink object. Every failure except a critical one (COM
        /// errors, a bad cast, an argument the shell rejects, anything a damaged .lnk file causes) becomes an
        /// <see cref="IOException"/>, which setup and uninstall handle.
        /// </summary>
        private static T WithShellLink<T>(Func<IShellLinkW, T> use)
        {
            object? instance = null;
            try
            {
                instance = new ShellLink();
                return use((IShellLinkW)instance);
            }
            catch (IOException)
            {
                throw;
            }
            catch (Exception ex) when (!CriticalExceptions.IsCritical(ex))
            {
                throw new IOException("The Start menu shortcut could not be read or written.", ex);
            }
            finally
            {
                if (instance != null)
                {
                    Marshal.ReleaseComObject(instance);
                }
            }
        }

        [ComImport]
        [Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLink
        {
        }

        [ComImport]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        [Guid("000214F9-0000-0000-C000-000000000046")]
        private interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);

            void GetIDList(out IntPtr ppidl);

            void SetIDList(IntPtr pidl);

            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);

            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);

            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);

            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);

            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);

            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);

            void GetHotkey(out short pwHotkey);

            void SetHotkey(short wHotkey);

            void GetShowCmd(out int piShowCmd);

            void SetShowCmd(int iShowCmd);

            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);

            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);

            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);

            void Resolve(IntPtr hwnd, uint fFlags);

            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
        }
    }
}
