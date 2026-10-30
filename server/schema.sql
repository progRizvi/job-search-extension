CREATE TABLE IF NOT EXISTS countries (
  code CHAR(2) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  status ENUM('pending','running','done') NOT NULL DEFAULT 'pending',
  next_query INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS urls (
  id INT AUTO_INCREMENT PRIMARY KEY,
  url_hash CHAR(40) NOT NULL UNIQUE,
  url TEXT NOT NULL,
  host VARCHAR(255) NOT NULL,
  kind ENUM('board','posting','company','unknown') NOT NULL DEFAULT 'unknown',
  status ENUM('new','checked','unreachable') NOT NULL DEFAULT 'new',
  engine VARCHAR(20),
  first_query VARCHAR(255),
  found_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_status (status, id)
);
CREATE TABLE IF NOT EXISTS url_countries (
  url_id INT NOT NULL,
  country_code CHAR(2) NOT NULL,
  query_text VARCHAR(255) NOT NULL,
  PRIMARY KEY (url_id, country_code, query_text)
);
CREATE TABLE IF NOT EXISTS job_results (
  id INT AUTO_INCREMENT PRIMARY KEY,
  url_id INT NOT NULL,
  job_hash CHAR(40) NOT NULL DEFAULT '',
  careers_url TEXT,
  openings VARCHAR(10),
  job_title VARCHAR(200),
  job_url TEXT,
  work_type VARCHAR(10),
  remote_scope VARCHAR(120),
  fit VARCHAR(10),
  stack VARCHAR(200),
  checked_by VARCHAR(20),
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_url_job (url_id, job_hash)
);
