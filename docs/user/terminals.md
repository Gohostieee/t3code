# Project terminals

Chats in the same project checkout share a default terminal. Your shell variables, current directory, output, and running commands remain available when you switch chats. Each linked worktree has a separate terminal group. Other projects and environments keep their own terminals, even when their names or repository URLs match.

Open **Project terminals** from a project's menu or the command palette to work without a chat. Choose a checkout, then choose a session. Mobile also offers **Project terminals** from the home screen. **New terminal** creates another independent shell; project scripts and worktree setup use their own task sessions.

The terminal shows its launch directory and the branch currently checked out there. Changing branches in that directory keeps the same shell. Typing `cd` changes the shell's current directory; it does not change the launch-directory label or move the session to another checkout.

Hiding a terminal, disconnecting, or archiving or deleting a chat leaves shared sessions running. **Terminate session** stops the process for every connected client. **Restart session** explicitly starts another process. **Clear output** affects the shared transcript. A closed or exited session never restarts just because another client reconnects. The next explicit Open action selects another live interactive session or creates a new one.

Removing a worktree lists its running sessions and asks before terminating them. Cancelling preserves the worktree and its terminals. If a checkout disappears or is replaced outside the app, its old terminal cannot run commands against a replacement directory. Removing a project terminates only that project's sessions.

A server restart ends its terminal processes. Saved output remains available, but it is not a running shell. Start a new terminal or explicitly restart an ended session to continue.

**Saved history** includes older sessions and separate, read-only transcripts from older versions that did not record a reliable checkout location. These transcripts are preserved without assigning them to a guessed checkout or combining their output. Update all clients together with the server when adopting project terminals.
