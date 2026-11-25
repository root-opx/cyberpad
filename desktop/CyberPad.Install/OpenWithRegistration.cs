using System;
using System.Collections.Generic;
using System.Linq;

namespace CyberPad.Install
{
    /// <summary>
    /// What the "Open with" registration (<c>HKCU\Software\Classes\Applications\CyberPad.exe</c>) looked like
    /// before the first install. Windows creates that key itself when someone uses "Open with → Choose another
    /// app" with the portable CyberPad.exe; setup then repoints it, and uninstall must put it back rather than
    /// delete it. The record lives in the uninstall entry, so an update keeps the original one.
    /// </summary>
    internal sealed class OpenWithRegistration
    {
        internal const string AddedFriendlyName = "FriendlyAppName";
        internal const string AddedCommand = "Command";
        internal const string AddedSupportedTypesKey = "SupportedTypes";

        private const char Separator = ';';
        private const int MaxAddedLength = 200;
        private const int MaxCommandLength = 2048;

        private OpenWithRegistration(bool existed, string? previousCommand, IReadOnlyList<string> added)
        {
            Existed = existed;
            PreviousCommand = previousCommand;
            Added = added;
        }

        /// <summary>True when the key existed before the first install.</summary>
        public bool Existed { get; }

        /// <summary>The open command it had then (a string value), or null.</summary>
        public string? PreviousCommand { get; }

        /// <summary>
        /// What setup added to the existing key: <see cref="AddedFriendlyName"/>, <see cref="AddedCommand"/>,
        /// <see cref="AddedSupportedTypesKey"/> (the whole key), or one of <see cref="InstallLayout.OpenWithTypes"/>.
        /// </summary>
        public IReadOnlyList<string> Added { get; }

        public static OpenWithRegistration None { get; } = new OpenWithRegistration(false, null, Array.Empty<string>());

        /// <summary>
        /// Reads the registration as it is now, before setup writes anything. A command that already equals
        /// <paramref name="ourCommand"/> is setup's own leftover, not a previous registration.
        /// </summary>
        public static OpenWithRegistration Capture(IRegistry registry, string ourCommand)
        {
            if (!registry.KeyExists(RegistryKeyId.OpenWithApplication))
            {
                return None;
            }

            string? command = registry.GetValue(RegistryKeyId.OpenWithCommand, string.Empty) as string;
            if (command != null && string.Equals(command, ourCommand, StringComparison.OrdinalIgnoreCase))
            {
                return None;
            }

            var added = new List<string>();
            if (!HasValue(registry, RegistryKeyId.OpenWithApplication, AddedFriendlyName))
            {
                added.Add(AddedFriendlyName);
            }

            if (command == null && !HasValue(registry, RegistryKeyId.OpenWithCommand, string.Empty))
            {
                added.Add(AddedCommand);
            }

            if (!registry.KeyExists(RegistryKeyId.OpenWithSupportedTypes))
            {
                added.Add(AddedSupportedTypesKey);
            }
            else
            {
                foreach (string type in InstallLayout.OpenWithTypes)
                {
                    if (!HasValue(registry, RegistryKeyId.OpenWithSupportedTypes, type))
                    {
                        added.Add(type);
                    }
                }
            }

            return new OpenWithRegistration(true, command, added);
        }

        /// <summary>
        /// Reads the record an earlier install saved in the uninstall entry. The values are checked against
        /// the fixed names; anything else is ignored. No record means the key did not exist before.
        /// </summary>
        public static OpenWithRegistration ReadSaved(IRegistry registry)
        {
            if (!(registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.OpenWithExistedValue) is int existed) || existed != 1)
            {
                return None;
            }

            object? savedCommand = registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.PreviousOpenCommandValue);
            if (savedCommand != null && !(savedCommand is string text && text.Length <= MaxCommandLength))
            {
                return None; // not a plausible command: handled as "did not exist before"
            }

            string? previous = savedCommand as string;
            var added = new List<string>();
            if (registry.GetValue(RegistryKeyId.UninstallEntry, RegistryKeys.OpenWithAddedValue) is string list && list.Length <= MaxAddedLength)
            {
                foreach (string name in list.Split(Separator))
                {
                    if (IsAllowedAddedName(name) && !added.Contains(name, StringComparer.Ordinal))
                    {
                        added.Add(name);
                    }
                }
            }

            return new OpenWithRegistration(true, previous, added);
        }

        /// <summary>
        /// Update: the record the first install saved. When someone has registered another command since (neither
        /// this install's nor the saved one), that command becomes the previous one so uninstall restores it.
        /// </summary>
        public static OpenWithRegistration ForUpdate(IRegistry registry, string ourCommand)
        {
            OpenWithRegistration saved = ReadSaved(registry);
            if (!registry.KeyExists(RegistryKeyId.OpenWithApplication))
            {
                return saved;
            }

            string? current = registry.GetValue(RegistryKeyId.OpenWithCommand, string.Empty) as string;
            if (current == null ||
                string.Equals(current, ourCommand, StringComparison.OrdinalIgnoreCase) ||
                (saved.PreviousCommand != null && string.Equals(current, saved.PreviousCommand, StringComparison.OrdinalIgnoreCase)))
            {
                return saved;
            }

            return saved.Existed ? new OpenWithRegistration(true, current, saved.Added) : Capture(registry, ourCommand);
        }

        /// <summary>Saves the record in the uninstall entry (nothing when the key did not exist before).</summary>
        public void Save(IRegistry registry)
        {
            if (!Existed)
            {
                // Drop a record left by an earlier install that is not valid any more.
                foreach (string name in new[] { RegistryKeys.OpenWithExistedValue, RegistryKeys.PreviousOpenCommandValue, RegistryKeys.OpenWithAddedValue })
                {
                    if (HasValue(registry, RegistryKeyId.UninstallEntry, name))
                    {
                        registry.DeleteValue(RegistryKeyId.UninstallEntry, name);
                    }
                }

                return;
            }

            registry.SetDword(RegistryKeyId.UninstallEntry, RegistryKeys.OpenWithExistedValue, 1);
            if (PreviousCommand != null)
            {
                registry.SetString(RegistryKeyId.UninstallEntry, RegistryKeys.PreviousOpenCommandValue, PreviousCommand);
            }

            registry.SetString(RegistryKeyId.UninstallEntry, RegistryKeys.OpenWithAddedValue, string.Join(Separator.ToString(), Added));
        }

        /// <summary>
        /// Uninstall: when the registration still runs this install's command, puts back what was there before
        /// (or deletes the key if setup created it). When something else changed the command since, the key is
        /// left as it is. Call before the uninstall entry (which holds the record) is deleted.
        /// </summary>
        public static void Remove(IRegistry registry, string? ourCommand)
        {
            if (ourCommand == null || !registry.KeyExists(RegistryKeyId.OpenWithApplication))
            {
                return;
            }

            string? current = registry.GetValue(RegistryKeyId.OpenWithCommand, string.Empty) as string;
            if (current == null || !string.Equals(current, ourCommand, StringComparison.OrdinalIgnoreCase))
            {
                return; // not ours any more
            }

            OpenWithRegistration saved = ReadSaved(registry);
            if (!saved.Existed)
            {
                registry.DeleteTree(RegistryKeyId.OpenWithApplication);
                return;
            }

            if (saved.PreviousCommand != null)
            {
                registry.SetString(RegistryKeyId.OpenWithCommand, string.Empty, saved.PreviousCommand);
            }
            else if (saved.Added.Contains(AddedCommand))
            {
                registry.DeleteValue(RegistryKeyId.OpenWithCommand, string.Empty);
            }

            if (saved.Added.Contains(AddedFriendlyName))
            {
                registry.DeleteValue(RegistryKeyId.OpenWithApplication, AddedFriendlyName);
            }

            if (saved.Added.Contains(AddedSupportedTypesKey))
            {
                registry.DeleteTree(RegistryKeyId.OpenWithSupportedTypes);
            }
            else
            {
                foreach (string type in InstallLayout.OpenWithTypes.Where(t => saved.Added.Contains(t)))
                {
                    registry.DeleteValue(RegistryKeyId.OpenWithSupportedTypes, type);
                }
            }
        }

        private static bool IsAllowedAddedName(string name) =>
            name == AddedFriendlyName || name == AddedCommand || name == AddedSupportedTypesKey ||
            InstallLayout.OpenWithTypes.Contains(name, StringComparer.Ordinal);

        private static bool HasValue(IRegistry registry, RegistryKeyId key, string name) =>
            registry.GetValueNames(key).Contains(name, StringComparer.OrdinalIgnoreCase);
    }
}
