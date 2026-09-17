# Supreme InfoTech Solutions (SIS) — Central Hub & Management System

An enterprise management platform for **Supreme InfoTech Solutions (SIS)**, integrating office inventory tracking, employee Daily Time Records (DTR), payroll processing, game schedule broadcasting, and administrative controls into a central web application.

---

## 🌟 Overview

SIS Central Hub provides a unified interface tailored to three distinct user roles (**Employee**, **Admin**, and **Super Admin**). Built using standard web technologies and backed by **Supabase**, the system offers real-time synchronization, secure SHA-256 authentication, barcode scanner integration, statutory tax/deduction calculations, network whitelisting, and automated report exports.

---

## 🚀 Key Modules & Features

### 1. 🏠 Central Hub (`home.html`, `home.js`)
* **Role-Based Views**: Displays personalized widgets and card navigation depending on user role.
* **Attendance & DTR Summary**: Quick view of active shift status, daily clock-in/clock-out banner, and interactive DTR modal.
* **Payslip Access**: Quick access to employee payslip records and history.

### 2. 📦 Office & Supply Inventory (`index.html`, `app.js`, `scanner.js`)
* **Asset Tracking**: Monitor office equipment, hardware, appliances, and supplies with brand, model, serial number, location, and status (`In Use`, `Spare`, `Defective`, `For Repair`).
* **Auto-Generated Unique IDs**: Category-based auto-incrementing identifiers (e.g., `SIS-LAP0001` for Laptops, `SIS-MON0001` for Monitors).
* **Realtime Sync**: WebSockets subscription updates inventory tables live across all open client sessions.
* **Barcode Scanner Integration (`scanner.js`)**:
  * **Lookup Mode**: Scan serials or barcodes to highlight items or prompt quick creation.
  * **Scan Session Mode**: Batch-scan incoming stock under a pre-selected category and location.
* **Bulk Actions & Excel Import/Export**: Select multiple items for status updates or deletion; import/export `.xlsx` spreadsheets via SheetJS.

### 3. 💵 Payroll Engine (`payroll.html`, `payroll.js`)
* **Employee Management**: Manage employee rosters, daily rates, positions, and statutory numbers (SSS, PhilHealth, Pag-IBIG).
* **Automated Deductions & Taxes**: Computes SSS contributions, PhilHealth premiums, Pag-IBIG deductions, and BIR withholding taxes based on system tax brackets.
* **Payslip & Report Generation**: Generates printable payslips and exports consolidated master payroll spreadsheets and PDF files (jsPDF & AutoTable).

### 4. 📅 Game Schedules (`schedule.html`, `schedule.js`)
* **Event Management**: Create and manage sports events (Golf, Baseball, Tennis, Volleyball, Car Racing) with venue details, call times, and match times.
* **Roster & Hole Assignments**: Assign employees to events (includes golf hole assignments 1–18 with duplicate prevention).
* **Live Call Time Countdown**: Ticking countdown timers indicating time remaining until required arrival.
* **Event Attendance & Time-In Gate**: Clock-in opens 2 hours prior to call time; tracks arrival status (`On Time`, `Late`).
* **Event Payroll PDF Export**: One-click generation of event payroll sheets with signature columns.

### 5. ⚡ Super Admin Control Center (`superadmin.html`)
* **Global Variables & Settings**: Update contribution rates (PhilHealth %, Pag-IBIG fixed, SSS caps/rates) and BIR tax ceilings.
* **Network IP Whitelisting**: Restrict time-in/time-out actions to authorized office Wi-Fi / LAN IP prefixes or static IPs.
* **Daily Call Time Manager**: Set global daily call times for employee punctuality tracking.
* **User Credential Generator**: Generate hashed user account JSON snippets for `users.json`.
* **Audit Logging**: Master history log tracking administrative operations and updates.
* **Manual Log Adjustments**: Fetch and override time-in/out records for any employee on a given date.

### 6. 🔒 Authentication & Security (`auth.js`, `users.json`)
* **Client-Side SHA-256 Hashing**: Passwords hashed using the Web Crypto API.
* **Session & Inactivity Management**: Handled via `sessionStorage` with automatic sign-out after 30 minutes of inactivity.
* **Account Lockout**: Temporary 15-minute account lock after 5 consecutive failed login attempts.

---

## 🛠️ Technology Stack

* **Frontend**: HTML5, CSS3 (Variables, Flexbox/Grid), ES6+ JavaScript
* **Database & Realtime**: Supabase (REST API & Realtime WebSockets)
* **Libraries**:
  * [SheetJS (xlsx)](https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js) — Excel import and export
  * [jsPDF](https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js) & [jspdf-autotable](https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js) — PDF generation
* **Fonts & Icons**: Barlow, Barlow Condensed, JetBrains Mono, inline SVGs

---

## 📂 Directory Structure

```
├── app.js               # Inventory core logic (Supabase REST, CRUD, real-time WS, import/export)
├── auth.js              # Authentication engine (SHA-256, session, lockout, inactivity timer)
├── config.js            # Supabase connection configuration (URL and public anon key)
├── home.css             # Styling for the Central Hub portal and slideshow
├── home.html            # Main Central Hub page
├── home.js              # Central Hub controller & employee DTR modal handling
├── index.html           # Office & Supply Inventory page
├── login.html           # Secure access / Sign-in screen
├── logo_hub.png         # Supreme InfoTech Solutions logo asset
├── payroll.html         # Payroll management page
├── payroll.js           # Payroll computation, employee rates, and payslip generation
├── payrollstyles.css    # Payroll & Super Admin module styles
├── profile.html         # User profile and DTR history view
├── scanner.js           # Barcode scanner input listener & Scan Session controller
├── schedule.html        # Game Schedules module page
├── schedule.js          # Sports event management, rosters, event attendance & payroll PDF
├── styles.css           # Global application stylesheet & design system variables
├── superadmin.html      # Super Admin Control Center (Settings, IP Whitelist, Audit, Users)
└── users.json           # User database with hashed credentials and roles
```

---

## 👥 User Roles & Permissions

| Module / Action | Employee | Admin | Super Admin |
| :--- | :---: | :---: | :---: |
| View Home Dashboard & Personal DTR | ✅ | ✅ | ✅ |
| View Inventory | ✅ | ✅ | ✅ |
| Add / Edit / Delete Inventory Items | ❌ | ✅ | ✅ |
| Import / Export Inventory Excel | ❌ | ✅ | ✅ |
| View Game Schedules | ✅ | ✅ | ✅ |
| Create / Edit Sports Events & Rosters | ❌ | ✅ | ✅ |
| Clock-In / Out of Assigned Events | ✅ | ✅ | ✅ |
| Run Payroll & View All Employee Payslips | ❌ | ✅ | ✅ |
| Access Super Admin Control Center | ❌ | ❌ | ✅ |
| Modify Statutory Contribution & Tax Brackets | ❌ | ❌ | ✅ |
| Manage Network IP Whitelists & Daily Call Times | ❌ | ❌ | ✅ |
| Adjust Manual Time Logs & View Audit Logs | ❌ | ❌ | ✅ |

---

## ⚙️ Setup & Deployment

### 1. Database Setup (Supabase)

Create a Supabase project and execute the following SQL scripts in the SQL Editor to create the necessary tables:

```sql
-- 1. Inventory
CREATE TABLE inventory (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  unique_id text,
  brand text,
  model text,
  category text,
  serial text,
  location text,
  status text,
  notes text,
  created_at timestamptz DEFAULT now()
);

-- 2. Employees
CREATE TABLE employees (
  id text PRIMARY KEY,
  username text,
  name text NOT NULL,
  position text,
  daily_rate numeric(10,2) DEFAULT 0,
  sss_no text,
  philhealth_no text,
  pagibig_no text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

-- 3. Daily Time Record (DTR) Logs
CREATE TABLE dtr_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id text REFERENCES employees(id) ON DELETE CASCADE,
  date date NOT NULL,
  time_in time,
  time_out time,
  is_late boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- 4. Payroll Periods & Records
CREATE TABLE payroll_periods (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  month text NOT NULL,
  label text,
  status text DEFAULT 'draft',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE payroll_records (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  period_id uuid REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id text,
  employee_name text,
  emp_type text DEFAULT 'regular',
  event_name text,
  days_present numeric(5,1) DEFAULT 0,
  working_days numeric(5,1) DEFAULT 0,
  gross_pay numeric(10,2) DEFAULT 0,
  sss numeric(10,2) DEFAULT 0,
  philhealth numeric(10,2) DEFAULT 0,
  pagibig numeric(10,2) DEFAULT 0,
  tax numeric(10,2) DEFAULT 0,
  net_pay numeric(10,2) DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 5. System Settings
CREATE TABLE system_settings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phic_rate numeric(4,2) DEFAULT 5.0,
  pagibig_fixed numeric(10,2) DEFAULT 100.0,
  sss_cap numeric(10,2) DEFAULT 1575.0,
  sss_rate numeric(4,2) DEFAULT 4.5,
  bir_b1 numeric(10,2) DEFAULT 20833.0,
  bir_b2 numeric(10,2) DEFAULT 33332.0,
  updated_at timestamptz DEFAULT now()
);

-- 6. Audit Logs
CREATE TABLE audit_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  username text,
  display_name text,
  action text NOT NULL,
  details text,
  created_at timestamptz DEFAULT now()
);

-- 7. Allowed Network IPs
CREATE TABLE allowed_ips (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type text NOT NULL DEFAULT 'prefix',
  value text NOT NULL,
  label text,
  created_at timestamptz DEFAULT now()
);

-- 8. Daily Call Times
CREATE TABLE call_times (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  date date NOT NULL UNIQUE,
  call_time time NOT NULL,
  label text,
  set_by text,
  created_at timestamptz DEFAULT now()
);

-- 9. Sport Events, Assignees, and Event Time-In Logs
CREATE TABLE sport_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_name text NOT NULL,
  sport text NOT NULL,
  call_date date,
  event_date date NOT NULL,
  event_time time,
  call_time time,
  venue text NOT NULL,
  status text DEFAULT 'upcoming',
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE sport_event_assignees (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id uuid REFERENCES sport_events(id) ON DELETE CASCADE,
  username text NOT NULL,
  hole_number integer,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE event_timein_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id uuid REFERENCES sport_events(id) ON DELETE CASCADE,
  username text,
  name text,
  time_in timestamptz,
  time_out timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Enable Row Level Security (RLS) & Policies
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE dtr_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowed_ips ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE sport_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sport_event_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_timein_logs ENABLE ROW LEVEL SECURITY;

-- Add anonymous access policies (for client anon key usage)
CREATE POLICY "Public read/write inventory" ON inventory FOR ALL USING (true);
CREATE POLICY "Public read/write employees" ON employees FOR ALL USING (true);
CREATE POLICY "Public read/write dtr_logs" ON dtr_logs FOR ALL USING (true);
CREATE POLICY "Public read/write payroll_periods" ON payroll_periods FOR ALL USING (true);
CREATE POLICY "Public read/write payroll_records" ON payroll_records FOR ALL USING (true);
CREATE POLICY "Public read/write system_settings" ON system_settings FOR ALL USING (true);
CREATE POLICY "Public read/write audit_logs" ON audit_logs FOR ALL USING (true);
CREATE POLICY "Public read/write allowed_ips" ON allowed_ips FOR ALL USING (true);
CREATE POLICY "Public read/write call_times" ON call_times FOR ALL USING (true);
CREATE POLICY "Public read/write sport_events" ON sport_events FOR ALL USING (true);
CREATE POLICY "Public read/write sport_event_assignees" ON sport_event_assignees FOR ALL USING (true);
CREATE POLICY "Public read/write event_timein_logs" ON event_timein_logs FOR ALL USING (true);
```

### 2. Configure Credentials & Connection

1. Update `config.js` with your Supabase credentials:
   ```javascript
   const SUPABASE_URL      = 'https://your-supabase-id.supabase.co';
   const SUPABASE_ANON_KEY = 'your-anon-key-here';
   ```
2. Modify or add user accounts in `users.json`. Hashes can be generated in the **Super Admin Control Center** or using standard SHA-256 generators.

### 3. Local Development / Hosting

Since the application is static frontend-driven, you can serve it with any HTTP server (e.g., Python, Nginx, Vercel, Netlify):

```bash
# Using Python 3
python -m http.server 8000

# Or using Node http-server / serve
npx http-server -p 8000
```

Open `http://localhost:8000/login.html` in your web browser.

---

## 📜 License

© 2026 **Supreme InfoTech Solutions**. All rights reserved. Confidential internal software.
