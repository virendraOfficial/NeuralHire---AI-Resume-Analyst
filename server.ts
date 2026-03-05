import express, { Request } from "express";
import { createServer as createViteServer } from "vite";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");
import Database from "better-sqlite3";
import { GoogleGenAI, Type } from "@google/genai";
import path from "path";

// Initialize Database
const db = new Database("ats_scanner.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    target_role TEXT,
    job_description TEXT,
    score INTEGER,
    analysis TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// Request Logger
app.use((req, res, next) => {
  if (req.url.startsWith("/api")) {
    console.log(`[API Request] ${req.method} ${req.url}`);
  }
  next();
});

// Normalize API URLs (remove trailing slashes)
app.use("/api", (req, res, next) => {
  if (req.url.length > 1 && req.url.split("?")[0].endsWith("/")) {
    const parts = req.url.split("?");
    const path = parts[0].slice(0, -1);
    const query = parts[1] ? `?${parts[1]}` : "";
    console.log(`[API Redirect] Normalizing ${req.url} to ${path}${query}`);
    res.redirect(301, path + query);
  } else {
    next();
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// API Routes
app.post("/api/extract", async (req, res) => {
  console.log("POST /api/extract - Request received (JSON/Base64)");
  try {
    const { base64, filename, mimetype } = req.body;

    if (!base64) {
      console.warn("POST /api/extract - No data provided");
      return res.status(400).json({ error: "Resume data is required" });
    }

    console.log(`POST /api/extract - Processing: ${filename} (${mimetype})`);
    
    const buffer = Buffer.from(base64, 'base64');

    // Extract text from PDF
    let resumeText = "";
    if (mimetype === "application/pdf") {
      try {
        console.log("Parsing PDF, buffer length:", buffer.length);
        
        // Handle various import/require patterns for pdf-parse
        let parseFunc: any = pdf;
        if (typeof parseFunc !== 'function' && (parseFunc as any).default) {
          parseFunc = (parseFunc as any).default;
        }
        
        if (typeof parseFunc !== 'function') {
          parseFunc = (pdf as any).pdf || (pdf as any).parse || pdf;
        }

        if (typeof parseFunc !== 'function') {
          throw new Error(`PDF parser is not a function (type: ${typeof parseFunc})`);
        }

        const data = await parseFunc(buffer);
        resumeText = data.text || "";
        console.log("PDF parsed successfully, text length:", resumeText.length);
      } catch (pdfError) {
        console.error("PDF parsing error details:", pdfError);
        return res.status(400).json({ error: `Failed to parse PDF file: ${pdfError instanceof Error ? pdfError.message : String(pdfError)}` });
      }
    } else {
      resumeText = buffer.toString("utf-8");
    }

    res.json({ 
      text: resumeText, 
      filename: filename 
    });
  } catch (error) {
    console.error("Extraction error:", error);
    res.status(500).json({ error: "Failed to extract text from resume" });
  }
});

app.post("/api/history", async (req, res) => {
  console.log("POST /api/history - Request received");
  try {
    const { filename, targetRole, jobDescription, analysis } = req.body;
    console.log(`POST /api/history - Saving scan for: ${filename}`);

    const stmt = db.prepare(`
      INSERT INTO scans (filename, target_role, job_description, score, analysis)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      filename,
      targetRole || "General",
      jobDescription || "",
      analysis.score,
      JSON.stringify(analysis)
    );

    res.json({ id: result.lastInsertRowid });
  } catch (error) {
    console.error("Save error:", error);
    res.status(500).json({ error: "Failed to save scan result" });
  }
});

app.get("/api/history", (req, res) => {
  const scans = db.prepare("SELECT * FROM scans ORDER BY created_at DESC").all();
  res.json(scans.map(s => ({ ...s, analysis: JSON.parse(s.analysis) })));
});

app.delete("/api/history/:id", (req, res) => {
  db.prepare("DELETE FROM scans WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// API 404 Handler - Prevent fall-through to Vite for /api routes
app.all("/api/*", (req, res) => {
  console.warn(`[API 404] ${req.method} ${req.url}`);
  res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
});

// Global Error Handler for API
app.use("/api", (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("API Error:", err);
  res.status(err.status || 500).json({ 
    error: err.message || "Internal Server Error",
    details: process.env.NODE_ENV !== "production" ? err.stack : undefined
  });
});

// Vite Middleware for Development
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static("dist"));
  app.get("*", (req, res) => {
    res.sendFile(path.resolve("dist", "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
