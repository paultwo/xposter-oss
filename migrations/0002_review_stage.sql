ALTER TABLE items ADD COLUMN review_stage TEXT NOT NULL DEFAULT 'draft' CHECK (review_stage IN (
  'draft',
  'needs_hemingway',
  'awaiting_paul'
));
