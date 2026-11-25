using System;
using System.Runtime.InteropServices;

namespace CyberPad.Install
{
    /// <summary>The real <see cref="IShellNotify"/>: SHChangeNotify(SHCNE_ASSOCCHANGED). Never exercised by the tests.</summary>
    public sealed class ShellNotify : IShellNotify
    {
        private const int ShcneAssocChanged = 0x08000000;
        private const uint ShcnfIdList = 0x0000;

        public void AssociationsChanged() => SHChangeNotify(ShcneAssocChanged, ShcnfIdList, IntPtr.Zero, IntPtr.Zero);

        [DllImport("shell32.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
    }
}
