using System;

namespace CyberPad.Install
{
    /// <summary>What the setup window shows for a fresh install or an update. Pure, so it can be tested.</summary>
    public sealed class SetupPlan
    {
        private SetupPlan(string heading, string button, string folder, bool isUpdate, string? fixedStatus, bool isBlocked = false)
        {
            Heading = heading;
            ButtonText = button;
            Folder = folder;
            IsUpdate = isUpdate;
            FixedStatus = fixedStatus;
            IsBlocked = isBlocked;
        }

        /// <summary>True when a newer version is installed: the button stays disabled and the status says why.</summary>
        public bool IsBlocked { get; }

        public string Heading { get; }

        public string ButtonText { get; }

        /// <summary>The text to put in the folder field first.</summary>
        public string Folder { get; }

        /// <summary>True when CyberPad is already installed: the field is read-only and Browse is disabled.</summary>
        public bool IsUpdate { get; }

        /// <summary>The status line for an update (nothing is evaluated); null for a fresh install.</summary>
        public string? FixedStatus { get; }

        /// <param name="version">The version this setup installs, e.g. <c>1.0.0</c>.</param>
        /// <param name="existingInstallDir">The folder of the install found through the uninstall entry, or null.</param>
        /// <param name="defaultFolder">The default install folder.</param>
        /// <param name="existingVersion">The version of that install (from its manifest), or null.</param>
        public static SetupPlan Create(string version, string? existingInstallDir, string defaultFolder, string? existingVersion = null)
        {
            if (version == null)
            {
                throw new ArgumentNullException(nameof(version));
            }

            if (existingInstallDir != null)
            {
                string heading = "Update CyberPad to " + version;
                if (existingVersion != null && InstallManifest.IsValidVersion(existingVersion) && InstallManifest.IsValidVersion(version) &&
                    InstallManifest.CompareVersions(version, existingVersion) < 0)
                {
                    return new SetupPlan(heading, "Update", existingInstallDir, true, InstallMessages.NewerInstalled(existingVersion), isBlocked: true);
                }

                return new SetupPlan(heading, "Update", existingInstallDir, true, SetupTexts.UpdateStatus);
            }

            return new SetupPlan("Install CyberPad " + version, "Install", defaultFolder ?? throw new ArgumentNullException(nameof(defaultFolder)), false, null);
        }
    }

    /// <summary>Sentences used only by the Setup and Uninstall windows (the rest are in <see cref="InstallMessages"/>).</summary>
    public static class SetupTexts
    {
        public const string Incomplete = "This setup file is incomplete. Download it again.";
        public const string StillCopying = "Setup is still copying files.";
        public const string SetupProblem = "Setup ran into a problem and did not finish. Nothing more will be changed.";
        public const string UninstallProblem = "Uninstall ran into a problem and did not finish.";
        public const string UpdateStatus = "CyberPad is already installed here and will be updated. To move it, uninstall it first.";
        public const string InstalledDone = "CyberPad is installed.";
        public const string UpdatedDone = "CyberPad was updated.";
        public const string NotStarted = "CyberPad is installed, but it could not be started. Start it from the Start menu.";
        public const string NotInstalledForAccount = "CyberPad is not installed for this account.";
        public const string AlreadyRunning = "CyberPad setup is already running.";
        public const string SetupElevated = "Run setup without administrator rights. CyberPad is installed for your own account.";
        public const string UninstallElevated = "Run uninstall without administrator rights.";
        public const string TempCopyFailed = "Uninstall could not prepare its temporary copy. Try again.";
        public const string ProgressName = "Installation progress";

        public static string DeleteNotesQuestion(string notesFolder) =>
            "Delete all CyberPad notes and settings in " + notesFolder + "? This cannot be undone.";

        public static string ErrorTypeLine(Exception ex) => "Error type: " + (ex?.GetType().Name ?? "unknown");

        /// <summary>The three-part version of a setup assembly (1.0.0.0 becomes 1.0.0).</summary>
        public static string FormatVersion(Version version)
        {
            if (version == null)
            {
                throw new ArgumentNullException(nameof(version));
            }

            return version.Major + "." + version.Minor + "." + Math.Max(version.Build, 0);
        }
    }
}
