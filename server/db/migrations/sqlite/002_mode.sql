-- #18 Phase4：回放列表需要 mode（乱斗/组队）用于展示，无需在列表里返回完整 events。
ALTER TABLE replays ADD COLUMN mode TEXT;
