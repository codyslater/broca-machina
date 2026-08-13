# remote brain over SSH

Your brain runs in tmux on another machine; broca-machina stays where the
mic/GPU is. Text is all that crosses the wire.

1. On the remote host, run your brain in tmux (session `main` here) and have
   it write voice replies to `~/.voice/say` (atomic tmp+`mv`, plain prose,
   short — the loop truncates at `maxReplyChars`).
2. Locally, deliver each transcript and pull replies:

   ```bash
   export SHUTTLE_HOST=your-brain-host          # ssh alias (ProxyJump ok)
   export SHUTTLE_TMUX=main
   export SHUTTLE_REMOTE_SAY='~/.voice/say'
   export SHUTTLE_LOCAL_REPLY=/abs/reply_in.txt # = transport.replyFile
   scripts/ssh-brain-shuttle.sh ensure-pull     # reply puller (idempotent)
   for f in /abs/transcripts_out/*.txt; do      # your inbox consumer's loop
     scripts/ssh-brain-shuttle.sh deliver "$f" && rm "$f"
   done
   ```

3. Handback: the remote brain replies `<<HANDBACK>>` → the shuttle runs
   `SHUTTLE_ON_HANDBACK` (point it at whatever restores your default brain)
   instead of speaking it.

   Add `ControlMaster auto` + `ControlPersist 10m` for the alias in
   `~/.ssh/config` — without it every op pays a full SSH handshake.
