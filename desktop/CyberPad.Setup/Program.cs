using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Windows.Forms;
using CyberPad.Install;
using CyberPad.Install.UI;

namespace CyberPad.Setup
{
    internal static class Program
    {
        /// <summary>Names of the two resources build.ps1 embeds.</summary>
        internal const string PayloadResource = "payload.zip";
        internal const string UninstallerResource = "Uninstall.exe";

        [STAThread]
        private static int Main()
        {
            // The library is embedded; its loader must be in place before any library type is touched.
            EmbeddedLibrary.Register();
            return Run();
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static int Run()
        {
            UiCommon.InstallExceptionHandlers(SetupTexts.SetupProblem);

            Assembly self = Assembly.GetExecutingAssembly();
            if (self.GetManifestResourceInfo(PayloadResource) == null || self.GetManifestResourceInfo(UninstallerResource) == null)
            {
                UiCommon.Error(null, "CyberPad Setup", SetupTexts.Incomplete);
                return 1;
            }

            InstallEnvironment env;
            ExistingInstall? existing;
            var registry = new WindowsRegistry();
            var probe = new FileSystemProbe();
            try
            {
                env = InstallEnvironment.FromSystem();
                existing = Installer.FindExisting(registry, probe, env);
            }
            catch (InstallException ex)
            {
                UiCommon.Error(null, "CyberPad Setup", ex.Message);
                return 1;
            }

            Version? assemblyVersion = self.GetName().Version;
            string version = SetupTexts.FormatVersion(assemblyVersion ?? new Version(1, 0, 0, 0));
            SetupPlan plan = SetupPlan.Create(version, existing?.InstallDir, env.DefaultInstallFolder);

            Application.Run(new SetupForm(plan, version, env, registry, probe, self));
            return 0;
        }
    }
}
