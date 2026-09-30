// Unicode-aware Windows shortcut reader/writer.
//
// WScript.Shell routes non-ASCII paths through the system ANSI code page: on an
// English-locale Windows (ACP 1252) it refuses a Chinese TargetPath and cannot
// save a Chinese-named .lnk. IShellLinkW / IPersistFile are the native Unicode
// interfaces, so they work regardless of the system locale.
//
// Language level must stay compatible with the C# 5 compiler used by
// Windows PowerShell 5.1's Add-Type: no string interpolation, no out vars.

using System;
using System.Text;
using System.Runtime.InteropServices;

namespace DoubaoWorkSkin
{
    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    internal interface IShellLinkW
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
        void GetHotkey(out ushort pwHotkey);
        void SetHotkey(ushort wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("0000010B-0000-0000-C000-000000000046")]
    internal interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        void IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [ComImport]
    [ClassInterface(ClassInterfaceType.None)]
    [Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLinkClass
    {
    }

    public static class Shortcut
    {
        private const int BufferCapacity = 4096;

        private static IShellLinkW CreateForRead(string linkPath)
        {
            IShellLinkW link = (IShellLinkW)new ShellLinkClass();
            ((IPersistFile)link).Load(linkPath, 0);
            return link;
        }

        public static void Save(string linkPath, string targetPath, string arguments, string description, string workingDirectory, string iconPath)
        {
            IShellLinkW link = (IShellLinkW)new ShellLinkClass();
            link.SetPath(targetPath);
            if (!string.IsNullOrEmpty(arguments)) link.SetArguments(arguments);
            if (!string.IsNullOrEmpty(description)) link.SetDescription(description);
            if (!string.IsNullOrEmpty(workingDirectory)) link.SetWorkingDirectory(workingDirectory);
            if (!string.IsNullOrEmpty(iconPath)) link.SetIconLocation(iconPath, 0);
            ((IPersistFile)link).Save(linkPath, true);
        }

        public static string GetTarget(string linkPath)
        {
            IShellLinkW link = CreateForRead(linkPath);
            StringBuilder buffer = new StringBuilder(BufferCapacity);
            link.GetPath(buffer, buffer.Capacity, IntPtr.Zero, 0);
            return buffer.ToString();
        }

        public static string GetArguments(string linkPath)
        {
            IShellLinkW link = CreateForRead(linkPath);
            StringBuilder buffer = new StringBuilder(BufferCapacity);
            link.GetArguments(buffer, buffer.Capacity);
            return buffer.ToString();
        }

        public static string GetDescription(string linkPath)
        {
            IShellLinkW link = CreateForRead(linkPath);
            StringBuilder buffer = new StringBuilder(BufferCapacity);
            link.GetDescription(buffer, buffer.Capacity);
            return buffer.ToString();
        }

        public static string GetWorkingDirectory(string linkPath)
        {
            IShellLinkW link = CreateForRead(linkPath);
            StringBuilder buffer = new StringBuilder(BufferCapacity);
            link.GetWorkingDirectory(buffer, buffer.Capacity);
            return buffer.ToString();
        }

        public static string GetIconLocation(string linkPath)
        {
            IShellLinkW link = CreateForRead(linkPath);
            StringBuilder buffer = new StringBuilder(BufferCapacity);
            int iconIndex;
            link.GetIconLocation(buffer, buffer.Capacity, out iconIndex);
            return buffer.ToString() + "," + iconIndex;
        }
    }
}
