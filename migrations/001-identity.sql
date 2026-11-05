CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_identities (
  provider text NOT NULL CHECK (provider = 'google'),
  subject text NOT NULL CHECK (length(subject) > 0),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, subject)
);
CREATE INDEX auth_identities_account ON auth_identities(account_id);
CREATE TABLE characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  room_id text NOT NULL CHECK (room_id IN ('br-1','br-2')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 14 AND name = btrim(name) AND left(name,1) <> '~'),
  name_key text NOT NULL CHECK (name_key = lower(name)),
  gender text NOT NULL CHECK (gender IN ('m','f')),
  role text NOT NULL CHECK (role IN ('nv','kt','hr','it','dev','sale','mkt','dsg','ts','bv','tv')),
  company text NOT NULL DEFAULT '' CHECK (length(company) <= 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, room_id),
  UNIQUE(room_id, name_key)
);
