using System;
using System.Reflection;
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

        private const string Caption = "CyberPad Setup";

        [STAThread]
        private static int Main()
        {
            // The library's code is compiled into this exe; no DLL is loaded from beside it.
            UiCommon.InstallExceptionHandlers(SetupTexts.SetupProblem);

            // CyberPad is installed for the signed-in account; an elevated setup is refused before anything else.
            if (ProcessGuard.IsElevated())
            {
                UiCommon.Error(null, Caption, SetupTexts.SetupElevated);
                return 1;
            }

            using (SingleInstance? instance = SingleInstance.TryTake(0))
            {
                if (instance == null)
                {
                    UiCommon.Info(null, Caption, SetupTexts.AlreadyRunning);
                    return 1;
                }

                return Run();
            }
        }

        private static int Run()
        {
            Assembly self = Assembly.GetExecutingAssembly();
            if (self.GetManifestResourceInfo(PayloadResource) == null || self.GetManifestResourceInfo(UninstallerResource) == null)
            {
                UiCommon.Error(null, Caption, SetupTexts.Incomplete);
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
                UiCommon.Error(null, Caption, ex.Message);
                return 1;
            }

            Version? assemblyVersion = self.GetName().Version;
            string version = SetupTexts.FormatVersion(assemblyVersion ?? new Version(1, 0, 0, 0));
            SetupPlan plan = SetupPlan.Create(version, existing?.InstallDir, env.DefaultInstallFolder, existing?.Version);

            Application.Run(new SetupForm(plan, version, env, registry, probe, self));
            return 0;
        }
    }
}
