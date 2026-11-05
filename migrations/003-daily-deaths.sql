-- Daily "bị sa thải" (knock-out) count next to the daily damage score.
ALTER TABLE daily_scores ADD COLUMN deaths integer NOT NULL DEFAULT 0;
