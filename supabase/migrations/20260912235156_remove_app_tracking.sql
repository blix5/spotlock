-- Removes the app-tracking stream.
--
-- The frontmost app could only ever be read by a local helper process
-- (helper/focus-helper.js, polling osascript over ws://127.0.0.1:8787). A
-- browser page cannot see app identity -- getDisplayMedia yields pixels and
-- nothing else, deliberately -- and browsers block ws:// from an https://
-- page, so the helper could never survive being hosted. docs/cv-plan.md §3
-- named that constraint when the helper was designed; this is it arriving.
--
-- Attention and playback are untouched: they are the two streams that answer
-- "which music keeps me focused", and neither needed the helper.
--
-- focus_by_track() reads only playback_intervals and attention_intervals, so
-- it needs no change.

drop table if exists app_intervals;

-- helper_connected recorded whether the app stream was genuinely live for a
-- session. With no app stream there is nothing for it to qualify.
alter table capture_sessions drop column if exists helper_connected;
