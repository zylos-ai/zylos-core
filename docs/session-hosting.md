# Session hosting

In multi-session mode, one session group can receive and answer messages for
another. Use `zylos host attach <source> --to <target>` to start hosting
immediately. Use `zylos host list` or Dashboard Settings to see active
relationships, who initiated them, when they started, and the notification
allowlist.

Incoming external messages, internal messages and scheduled tasks for the
source go to the host while the relationship is active. The host can reply to
the source's addresses. Replies appear in the sending group's history. The
source can still reply to addresses it owns.

If the target is itself hosted, the relationship points directly to its host.
Groups hosted by the source move with it to that same host. Origin can host
other groups.

Hosting sends a bilingual notice to the owner through the configured alert
destination. If that destination is unavailable or unset, the notice goes to
Dashboard's pinned Origin conversation. Use `zylos host allow <channel>`, `zylos host disallow
<channel>`, or Dashboard Settings to mute or restore attach notices for a
channel. Editing the notification allowlist sends an owner notice.

Use `zylos host detach <source>` or Dashboard Settings to end a relationship
immediately. Finish replies before detaching so the host still has access to
the source's addresses. Each group's existing history and rules stay with that
group. If a group is hosted by mistake, the host may have already read messages
received before the relationship was detached.
