#!/usr/bin/env python3
"""
Minimal PTY wrapper. Spawns a command in a pseudo-terminal,
proxies stdin/stdout, AND accepts injected input via a named pipe.

Usage: pty-wrap.py <inject_pipe> <command> [args...]

The inject_pipe is a path to a named pipe (FIFO). Any data written
to it gets forwarded to the child's stdin as if the user typed it.
"""
import sys, os, pty, select, signal, errno

def main():
    if len(sys.argv) < 3:
        print("Usage: pty-wrap.py <inject_pipe> <command> [args...]", file=sys.stderr)
        sys.exit(1)

    inject_pipe = sys.argv[1]
    cmd = sys.argv[2:]

    # Create the named pipe for injection
    if not os.path.exists(inject_pipe):
        os.mkfifo(inject_pipe)

    # Fork with PTY
    pid, fd = pty.fork()

    if pid == 0:
        # Child: exec the command
        os.execvp(cmd[0], cmd)
        sys.exit(1)

    # Parent: proxy stdin + inject pipe → child PTY, child PTY → stdout
    import termios, tty, struct, fcntl

    old_settings = None
    if os.isatty(0):
        old_settings = termios.tcgetattr(0)
        tty.setraw(0)

    # Set PTY size to match the real terminal
    def sync_size():
        if os.isatty(0):
            try:
                sz = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\x00' * 8)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, sz)
            except: pass
    sync_size()

    # Forward SIGWINCH (terminal resize) to child PTY
    signal.signal(signal.SIGWINCH, lambda s, f: sync_size())

    # Open inject pipe — open RDWR so we don't block and don't get EOF when no writer
    inject_fd = os.open(inject_pipe, os.O_RDWR | os.O_NONBLOCK)

    def cleanup():
        if old_settings:
            termios.tcsetattr(0, termios.TCSADRAIN, old_settings)
        try: os.close(inject_fd)
        except: pass
        try: os.unlink(inject_pipe)
        except: pass

    # SIGWINCH already handled above for resize sync

    try:
        while True:
            try:
                rlist = [0, fd, inject_fd]  # stdin, child PTY, inject pipe
                r, _, _ = select.select(rlist, [], [], 0.1)
            except (select.error, OSError) as e:
                if hasattr(e, 'errno') and e.errno == errno.EINTR:
                    continue
                break

            if 0 in r:
                # User keystroke → child
                data = os.read(0, 1024)
                if not data:
                    break
                os.write(fd, data)

            if fd in r:
                # Child output → stdout + cleaned log for mobile viewing
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        break
                    os.write(1, data)
                    # Strip ANSI escapes and write clean text to log
                    try:
                        import re
                        clean = re.sub(rb'\x1b\[[0-9;]*[a-zA-Z]', b'', data)
                        clean = re.sub(rb'\x1b\][^\x07]*\x07', b'', clean)
                        clean = re.sub(rb'\x1b\[[\?0-9;]*[a-zA-Z]', b'', clean)
                        clean = re.sub(rb'\r', b'', clean)  # strip carriage returns
                        # Only write if there's actual content (not just cursor moves)
                        stripped = clean.strip()
                        if stripped and len(stripped) > 1:
                            log_path = inject_pipe + ".log"
                            with open(log_path, "ab") as f:
                                f.write(clean)
                            # Truncate if over 100KB (keep tail)
                            if os.path.getsize(log_path) > 100000:
                                with open(log_path, "rb") as f:
                                    f.seek(-60000, 2)
                                    tail = f.read()
                                with open(log_path, "wb") as f:
                                    f.write(tail)
                    except: pass
                except OSError:
                    break

            if inject_fd in r:
                # Injected message → child PTY
                # Replace \n with \r so the TUI treats it as Enter keypress
                try:
                    data = os.read(inject_fd, 4096)
                    if data:
                        os.write(fd, data.replace(b"\n", b"\r"))
                except OSError:
                    pass

    finally:
        cleanup()
        # Wait for child
        try:
            _, status = os.waitpid(pid, 0)
            sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
        except:
            sys.exit(0)

if __name__ == "__main__":
    main()
