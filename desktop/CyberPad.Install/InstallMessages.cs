namespace CyberPad.Install
{
    /// <summary>Every user-facing sentence the library produces, in one place.</summary>
    public static class InstallMessages
    {
        // Folder rules (spec, "Choosing the folder").
        public const string LocalDrive = "Choose a folder on a local drive.";
        public const string TooLongOrBadCharacters = "That path is too long or contains characters that cannot be used.";
        public const string ParentReference = "Type the full path of the folder, without \"..\".";
        public const string SharedFolder = "Choose a folder of its own for CyberPad, not a shared folder.";
        public const string NotesFolder = "That folder holds your notes. Choose a different one.";
        public const string NeedsAdmin = "That folder needs administrator rights. Choose a folder inside your own user folder.";
        public const string Link = "That folder is a link to another location. Choose a real folder.";
        public const string CannotWrite = "Setup cannot write to that folder.";
        public const string OutsideProfile = "Choose a folder inside your own user folder.";
        public const string ProfileHasPercent =
            "Your user folder's name contains %, which Windows would misread. CyberPad cannot be installed for this account.";

        // Not in the spec: the CyberPad subfolder of a non-empty folder is itself non-empty and not an install.
        public const string SubfolderOccupied = "That folder already has a CyberPad folder with other files in it. Choose a different folder.";

        // Status lines under the folder field.
        public const string WillCreate = "This folder will be created.";
        public const string WillInstallHere = "CyberPad will be installed in this folder.";
        public const string WillUpdate = "CyberPad is already installed here and will be updated.";

        /// <summary>The status line when the chosen folder had other files and its CyberPad subfolder is used.</summary>
        public static string WillInstallIn(string folder) => "CyberPad will be installed in " + folder + ".";

        // Installing.
        public const string CloseToInstall = "Close CyberPad, then choose Install again.";
        public const string CloseToUpdate = "Close CyberPad, then choose Update again.";
        public const string CannotReplaceApp = "Setup cannot replace CyberPad.exe. Check that the file is not read-only.";
        public const string FolderChanged = "That folder changed since you chose it. Check the folder and choose Install again.";
        public const string UnexpectedFailure = "Setup stopped because of an unexpected problem and undid its changes. Try again.";
        public const string InstalledCleanupIncomplete = "CyberPad was installed, but setup could not finish cleaning up.";
        public const string PayloadDamaged = "The setup file is damaged. Download CyberPad again.";
        public const string FilesInTheWay = "That folder has files that setup did not install. Choose a different folder.";
        public const string WriteFailed = "Setup could not write to the install folder. Check that no other program is using it, then try again.";
        public const string ShortcutFailed = "Setup could not create the Start menu shortcut. Try again.";
        public const string RegistryFailed = "Setup could not register CyberPad with Windows. Try again.";
        public const string NotifyFailed = "Setup could not tell Windows about the new file types. Try again.";
        public const string UndoIncomplete = "Setup stopped and could not undo every change. Run setup again to repair CyberPad.";
        public const string Installed = "CyberPad is installed.";

        /// <summary>Setup never replaces a newer install with an older version.</summary>
        public static string NewerInstalled(string installedVersion) =>
            "A newer version of CyberPad (" + installedVersion + ") is already installed.";

        // Shared by setup and uninstall, so neither program's name is used.
        public const string RegistryReadFailed = "CyberPad's install record could not be read. Try again.";
        public const string NoUserFolders = "Your user folders could not be found.";

        // Uninstalling (never "Setup" in these).
        public const string NotInstalled = "CyberPad could not be found, or its install record is damaged. Nothing was removed.";
        public const string CloseToUninstall = "Close CyberPad, then choose Uninstall again.";
        public const string Removed = "CyberPad was removed.";
        public const string RemovedWithLeftoversPrefix = "CyberPad was removed. Some files could not be deleted: ";
        public const string RemovedButShortcutOrEntryLeft =
            "CyberPad was removed, but its Start menu shortcut or its entry under Installed apps could not be deleted.";
        public const string NotesFolderRefused = "The notes folder could not be checked, so it was not deleted.";
        public const string CannotDeleteApp = "Uninstall cannot delete CyberPad.exe. Check that the file is not read-only.";
        public const string FolderNotChecked = "CyberPad's entry was removed. No files were deleted because the install folder could not be checked.";
        public const string ShortcutRemovedToo = " The Start menu shortcut was removed too.";

        /// <summary>Uninstall found the entry and a valid folder, but no valid file list: no file was deleted.</summary>
        public static string FileListMissing(string folder) =>
            "CyberPad's entry was removed. The files in " + folder + " were left because setup's file list is missing or damaged.";

        /// <summary>Some of the notes folder could not be deleted.</summary>
        public static string NotesLeft(string folder) =>
            "Some notes could not be deleted. Delete what is left in " + folder + " yourself.";
    }
}
