namespace CyberPad.Install
{
    /// <summary>Every user-facing sentence the library produces, in one place.</summary>
    public static class InstallMessages
    {
        // Folder rules (spec, "Choosing the folder").
        public const string LocalDrive = "Choose a folder on a local drive.";
        public const string TooLongOrBadCharacters = "That path is too long or contains characters that cannot be used.";
        public const string SharedFolder = "Choose a folder of its own for CyberPad, not a shared folder.";
        public const string NotesFolder = "That folder holds your notes. Choose a different one.";
        public const string NeedsAdmin = "That folder needs administrator rights. Choose a folder in your own profile.";
        public const string Link = "That folder is a link to another location. Choose a real folder.";
        public const string CannotWrite = "Setup cannot write to that folder.";
        public const string OutsideProfile = "Choose a folder inside your own user folder.";

        // Not in the spec: the CyberPad subfolder of a non-empty folder is itself non-empty and not an install.
        public const string SubfolderOccupied = "That folder already has a CyberPad folder with other files in it. Choose a different folder.";

        // Status lines under the folder field.
        public const string WillCreate = "This folder will be created.";
        public const string WillInstallHere = "CyberPad will be installed in this folder.";
        public const string WillUpdate = "CyberPad is already installed here and will be updated.";

        // Installing.
        public const string CloseToInstall = "Close CyberPad, then choose Install again.";
        public const string CannotReplaceApp = "Setup cannot replace CyberPad.exe. Check that the file is not read-only.";
        public const string UnexpectedFailure = "Setup stopped because of an unexpected problem and undid its changes. Try again.";
        public const string PayloadDamaged = "The setup file is damaged. Download CyberPad again.";
        public const string FilesInTheWay = "That folder has files that setup did not install. Choose a different folder.";
        public const string WriteFailed = "Setup could not write to the install folder. Check that no other program is using it, then try again.";
        public const string ShortcutFailed = "Setup could not create the Start menu shortcut. Try again.";
        public const string RegistryFailed = "Setup could not register CyberPad with Windows. Try again.";
        public const string NotifyFailed = "Setup could not tell Windows about the new file types. Try again.";
        public const string RegistryReadFailed = "Setup could not read CyberPad's install record. Try again.";
        public const string UndoIncomplete = "Setup stopped and could not undo every change. Run setup again to repair CyberPad.";
        public const string Installed = "CyberPad is installed.";

        // Uninstalling.
        public const string NotInstalled = "CyberPad could not be found, or its install record is damaged. Nothing was removed.";
        public const string CloseToUninstall = "Close CyberPad, then choose Uninstall again.";
        public const string Removed = "CyberPad was removed.";
        public const string RemovedWithLeftoversPrefix = "CyberPad was removed. Some files could not be deleted: ";
        public const string NotesFolderRefused = "The notes folder could not be checked, so it was not deleted.";
        public const string CannotDeleteApp = "Uninstall cannot delete CyberPad.exe. Check that the file is not read-only.";

        /// <summary>Uninstall found the entry but no valid file list: only the entry and the shortcut were removed.</summary>
        public static string EntryRemovedFilesLeft(string folder) =>
            "CyberPad's entry and shortcut were removed. The files in " + folder + " were left because setup's file list is missing.";

        // Environment.
        public const string NoUserFolders = "Setup could not find your user folders.";
    }
}
