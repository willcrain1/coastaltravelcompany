INSERT OR IGNORE INTO automation_settings (id, trigger_key, label, enabled, delay_hours, updated_at) VALUES
  ('a7', 'contract_signed_deposit_invoice', 'Auto-send deposit invoice when contract is signed', 0, 0,  datetime('now')),
  ('a8', 'invoice_due_reminder',            'Payment reminder 3 days before invoice due date',   0, 0,  datetime('now')),
  ('a9', 'final_payment_thank_you',         'Thank-you email when final payment is received',    0, 0,  datetime('now'));
