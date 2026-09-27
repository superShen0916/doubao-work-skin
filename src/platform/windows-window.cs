using System;
using System.Runtime.InteropServices;

namespace DoubaoWorkSkin {
    public static class WindowActivation {
        private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attachTo, uint attachFrom, bool attach);

        public static string TryActivate(int processId) {
            if (processId <= 0) return "invalid-pid";
            IntPtr candidate = FindWindow(processId);
            if (candidate == IntPtr.Zero) return "no-window";
            if (IsIconic(candidate)) ShowWindowAsync(candidate, 9); // SW_RESTORE
            else if (!IsWindowVisible(candidate)) ShowWindowAsync(candidate, 5); // SW_SHOW
            // SetForegroundWindow normally permits only the current foreground
            // thread. AttachThreadInput is the minimal documented focus handshake;
            // it injects no keys and does not bypass system foreground locks.
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out _);
            uint currentThread = GetCurrentThreadId();
            bool attached = foregroundThread != 0 && foregroundThread != currentThread
                && AttachThreadInput(currentThread, foregroundThread, true);
            try {
                BringWindowToTop(candidate);
                SetForegroundWindow(candidate);
                return GetForegroundWindow() == candidate ? "foreground" : "shown";
            } finally {
                if (attached) AttachThreadInput(currentThread, foregroundThread, false);
            }
        }

        private static IntPtr FindWindow(int processId) {
            IntPtr candidate = IntPtr.Zero;
            int bestScore = -1;
            EnumWindows(delegate(IntPtr window, IntPtr parameter) {
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner != (uint)processId || GetWindow(window, 4) != IntPtr.Zero) return true;
                bool visible = IsWindowVisible(window);
                bool titled = GetWindowTextLength(window) > 0;
                if (!visible && !titled) return true;
                int score = (visible ? 2 : 0) + (titled ? 1 : 0);
                if (score > bestScore) { candidate = window; bestScore = score; }
                return true;
            }, IntPtr.Zero);
            return candidate;
        }
    }
}
