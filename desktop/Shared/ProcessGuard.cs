using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using CyberPad.Install;

namespace CyberPad.Install.UI
{
    /// <summary>Start-up checks shared by Setup and Uninstall (linked into both projects).</summary>
    internal static class ProcessGuard
    {
        private const int TokenElevationClass = 20; // TOKEN_INFORMATION_CLASS.TokenElevation

        /// <summary>
        /// True when this process runs with an elevated token, read with GetTokenInformation(TokenElevation)
        /// on the process token. Fails closed: if the answer cannot be read, the process is treated as elevated.
        /// </summary>
        public static bool IsElevated()
        {
            try
            {
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query))
                {
                    IntPtr buffer = Marshal.AllocHGlobal(sizeof(int));
                    try
                    {
                        if (!GetTokenInformation(identity.Token, TokenElevationClass, buffer, sizeof(int), out int returned) || returned != sizeof(int))
                        {
                            return true;
                        }

                        return Marshal.ReadInt32(buffer) != 0;
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buffer);
                    }
                }
            }
            catch (Exception ex) when (ex is System.Security.SecurityException || ex is UnauthorizedAccessException)
            {
                return true;
            }
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int tokenInformationLength, out int returnLength);
    }

    /// <summary>
    /// The named mutex <see cref="UninstallStages.MutexName"/>, held for as long as this object lives. Dispose
    /// it on the thread that took it.
    /// </summary>
    internal sealed class SingleInstance : IDisposable
    {
        private Mutex? _mutex;

        private SingleInstance(Mutex mutex)
        {
            _mutex = mutex;
        }

        /// <summary>Takes the mutex, waiting at most <paramref name="waitMilliseconds"/>; null when another instance holds it.</summary>
        public static SingleInstance? TryTake(int waitMilliseconds)
        {
            Mutex mutex;
            try
            {
                mutex = new Mutex(false, UninstallStages.MutexName);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException || ex is IOException || ex is WaitHandleCannotBeOpenedException)
            {
                return null; // it exists and cannot be used: treat it as held
            }

            bool owned;
            try
            {
                owned = mutex.WaitOne(waitMilliseconds);
            }
            catch (AbandonedMutexException)
            {
                owned = true; // the previous holder ended without releasing it; it is ours now
            }

            if (!owned)
            {
                mutex.Dispose();
                return null;
            }

            return new SingleInstance(mutex);
        }

        public void Dispose()
        {
            if (_mutex != null)
            {
                _mutex.ReleaseMutex();
                _mutex.Dispose();
                _mutex = null;
            }
        }
    }
}
