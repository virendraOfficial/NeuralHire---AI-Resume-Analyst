import React, { useState, useEffect, useRef } from "react";
import { 
  Upload, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  History as HistoryIcon, 
  LayoutDashboard, 
  Search,
  Trash2,
  ChevronRight,
  Target,
  FileSearch,
  TrendingUp,
  TrendingDown,
  RefreshCcw,
  Plus,
  Download
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { GoogleGenAI, Type } from "@google/genai";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: (process.env as any).GEMINI_API_KEY });

interface Analysis {
  score: number;
  scoreBreakdown: {
    keywordMatch: number;
    experienceRelevance: number;
    formatting: number;
    impactAndMetrics: number;
  };
  summary: string;
  strengths: { point: string; evidence: string }[];
  weaknesses: { point: string; recommendation: string }[];
  keywordsFound: string[];
  missingKeywords: string[];
  formattingTips: string[];
  impactAnalysis: {
    rating: string;
    feedback: string;
    examplesFound: string[];
  };
  roleSuitability: string;
}

interface Scan {
  id: number;
  filename: string;
  target_role: string;
  job_description: string;
  score: number;
  analysis: Analysis;
  created_at: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<"scan" | "history">("scan");
  const [file, setFile] = useState<File | null>(null);
  const [targetRole, setTargetRole] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<Analysis | null>(null);
  const [previousScore, setPreviousScore] = useState<number | null>(null);
  const [history, setHistory] = useState<Scan[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchHistory();
    checkServerHealth();
  }, []);

  const checkServerHealth = async () => {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) console.warn("Server health check failed");
    } catch (err) {
      console.error("Server unreachable", err);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch("/api/history");
      const data = await res.json();
      setHistory(data);
    } catch (err) {
      console.error("Failed to fetch history", err);
    }
  };

  const resetScan = () => {
    setFile(null);
    setResult(null);
    setPreviousScore(null);
    // We keep targetRole and jobDescription as the user might want to scan another resume for the same role
  };

  const downloadPDF = async () => {
    if (!resultsRef.current || !result) return;
    
    setIsDownloading(true);
    try {
      const canvas = await html2canvas(resultsRef.current, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: "#F9FAFB" // Match the page background
      });
      
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "px",
        format: [canvas.width / 2, canvas.height / 2]
      });
      
      pdf.addImage(imgData, "PNG", 0, 0, canvas.width / 2, canvas.height / 2);
      pdf.save(`ATS-Verdict-${targetRole.replace(/\s+/g, "-")}.pdf`);
    } catch (err) {
      console.error("Failed to generate PDF", err);
      alert("Failed to generate PDF. Please try again.");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleScan = async () => {
    if (!file) return;
    
    // Check for Target Role (Mandatory)
    if (!targetRole.trim()) {
      alert("Please enter a Target Role to scan your resume against.");
      return;
    }

    // Check for API Key early
    if (!(process.env as any).GEMINI_API_KEY) {
      alert("Gemini API Key is missing. Please ensure it is set in your environment variables.");
      return;
    }

    setIsScanning(true);
    setResult(null);

    try {
      // 0. Find previous analysis for context
      const prev = history.find(s => s.target_role === targetRole);
      setPreviousScore(prev ? prev.score : null);
      const previousContext = prev ? `
        PREVIOUS ANALYSIS OF THIS CANDIDATE FOR THIS ROLE:
        - Previous Score: ${prev.score}
        - Previous Weaknesses: ${prev.analysis.weaknesses.map(w => w.point).join(", ")}
        - Previous Missing Keywords: ${prev.analysis.missingKeywords.join(", ")}
        
        INSTRUCTION: If the candidate has addressed previous weaknesses or added missing keywords, you MUST reward them with a higher score in the relevant category. Be consistent and objective.
      ` : "";

      // 1. Convert file to Base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1]); // Remove data:application/pdf;base64,
        };
        reader.onerror = (error) => reject(error);
      });

      // 2. Extract text from resume
      const extractRes = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base64,
          filename: file.name,
          mimetype: file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'text/plain'),
        }),
      });
      
      const extractContentType = extractRes.headers.get("content-type");
      let extractData;
      
      if (extractContentType?.includes("application/json")) {
        extractData = await extractRes.json();
      } else {
        const text = await extractRes.text();
        console.error("Non-JSON response from /api/extract:", text.substring(0, 500));
        
        // Check if it looks like the index.html fallback
        if (text.includes("<!doctype html>") || text.includes("<html")) {
          throw new Error(`The server is returning the main application page instead of the API response. This usually means the API route is not correctly configured or the server is still starting up. Status: ${extractRes.status}`);
        }
        
        throw new Error(`Server returned an unexpected response format (${extractRes.status}). Please check the browser console for details.`);
      }
      
      if (!extractRes.ok) {
        throw new Error(extractData?.error || "Failed to extract text");
      }
      
      const { text: resumeText, filename } = extractData;

      // 3. Analyze with Gemini
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `
          You are a Senior Technical Recruiter and Hiring Manager with 20+ years of experience in talent acquisition.
          Your task is to provide a deep, critical, and highly accurate ATS (Applicant Tracking System) analysis of the provided resume.
          
          TARGET ROLE: ${targetRole}
          JOB DESCRIPTION: ${jobDescription || "Not provided. Use industry standards for the Target Role."}
          
          RESUME TEXT:
          ${resumeText}
          
          ${previousContext}
          
          STRICT ANALYSIS REQUIREMENTS:
          1. **Scoring Model**: 
             - Keyword Match (25%): How well do the hard and soft skills align?
             - Experience Relevance (40%): Evaluate the DEPTH of experience. For Senior/Lead roles, prioritize leadership (hiring, sprint ownership, team size) and architectural depth (system design patterns, optimization) over simple tool lists.
             - Impact & Metrics (25%): Be extremely strict. Count the number of unique metrics. A resume with 30+ metrics is "Elite", while 10-15 is "Standard".
             - Formatting (10%): Is the resume structured for machine readability?
          
          2. **Seniority-Aware Evaluation**: 
             - If the target role is "Lead" or "Manager", leadership metrics must carry 2x weight in the final score. 
             - Distinguish between "Mentoring" (IC) and "Managing/Hiring/Sprints" (Lead).
             - Look for specific architectural patterns (e.g., distributed locking, request coalescing, N+1 fixes) over just listing tool names.
          
          3. **Evidence-Based Strengths**: For every strength identified, you MUST provide direct evidence or a quote from the resume text.
          
          4. **Actionable Weaknesses**: For every weakness, provide a specific, actionable recommendation on how to fix it.
          
          5. **Impact Analysis**: 
             - Rate the impact as "Strong", "Average", or "Weak".
             - Identify specific examples of quantifiable achievements.
             - If no metrics are found, explain how to convert responsibilities into achievements.
          
          6. **Role Suitability**: Provide a final verdict on whether this candidate should be shortlisted for an interview for the role of ${targetRole}.
          
          7. **Keyword Precision**: Only suggest keywords that are truly essential for the ${targetRole}. Do not over-reward "Tech Breadth" (polyglotism) if the "Depth" (specialization) is more relevant for the role.
          
          8. **Objectivity & Progress**: If this is a re-scan (see PREVIOUS ANALYSIS), your primary goal is to evaluate if the candidate has improved. If they have addressed previous feedback, their score MUST increase.
          
          Provide the analysis in JSON format.
          IMPORTANT: Return ONLY the JSON object.
        `,
        config: {
          temperature: 0, // Ensure consistency and objectivity
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              score: { type: Type.NUMBER },
              scoreBreakdown: {
                type: Type.OBJECT,
                properties: {
                  keywordMatch: { type: Type.NUMBER },
                  experienceRelevance: { type: Type.NUMBER },
                  formatting: { type: Type.NUMBER },
                  impactAndMetrics: { type: Type.NUMBER },
                },
                required: ["keywordMatch", "experienceRelevance", "formatting", "impactAndMetrics"],
              },
              summary: { type: Type.STRING },
              strengths: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT,
                  properties: {
                    point: { type: Type.STRING },
                    evidence: { type: Type.STRING },
                  },
                  required: ["point", "evidence"],
                } 
              },
              weaknesses: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT,
                  properties: {
                    point: { type: Type.STRING },
                    recommendation: { type: Type.STRING },
                  },
                  required: ["point", "recommendation"],
                } 
              },
              keywordsFound: { type: Type.ARRAY, items: { type: Type.STRING } },
              missingKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
              formattingTips: { type: Type.ARRAY, items: { type: Type.STRING } },
              impactAnalysis: { 
                type: Type.OBJECT,
                properties: {
                  rating: { type: Type.STRING },
                  feedback: { type: Type.STRING },
                  examplesFound: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: ["rating", "feedback", "examplesFound"],
              },
              roleSuitability: { type: Type.STRING },
            },
            required: ["score", "scoreBreakdown", "summary", "strengths", "weaknesses", "keywordsFound", "missingKeywords", "formattingTips", "impactAnalysis", "roleSuitability"],
          },
        },
      });

      let rawText = response.text || "{}";
      rawText = rawText.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
      const analysis = JSON.parse(rawText);

      // 3. Save to history
      const historyRes = await fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename,
          targetRole,
          jobDescription,
          analysis
        }),
      });

      if (!historyRes.ok) {
        console.warn("Failed to save to history, but analysis is complete.");
      }

      setResult(analysis);
      fetchHistory();
    } catch (err: any) {
      console.error("Scan failed", err);
      alert(err.message || "Scan failed. Please try again.");
    } finally {
      setIsScanning(false);
    }
  };

  const deleteScan = async (id: number) => {
    try {
      await fetch(`/api/history/${id}`, { method: "DELETE" });
      fetchHistory();
    } catch (err) {
      console.error("Delete failed", err);
    }
  };

  return (
    <div className="min-h-screen bg-[#F9FAFB] text-[#111827] font-sans">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-white border-r border-[#E5E7EB] p-6 z-20">
        <div className="flex items-center gap-2 mb-10">
          <div className="w-8 h-8 bg-[#2563EB] rounded-lg flex items-center justify-center">
            <FileSearch className="text-white w-5 h-5" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">ATS Scan Pro</h1>
        </div>

        <nav className="space-y-1">
          <button
            onClick={() => setActiveTab("scan")}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
              activeTab === "scan" 
                ? "bg-[#EFF6FF] text-[#2563EB]" 
                : "text-[#6B7280] hover:bg-[#F3F4F6]"
            )}
          >
            <LayoutDashboard className="w-4 h-4" />
            New Scan
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all",
              activeTab === "history" 
                ? "bg-[#EFF6FF] text-[#2563EB]" 
                : "text-[#6B7280] hover:bg-[#F3F4F6]"
            )}
          >
            <HistoryIcon className="w-4 h-4" />
            History
          </button>
        </nav>

        <div className="absolute bottom-6 left-6 right-6">
          <div className="p-4 bg-[#F3F4F6] rounded-2xl">
            <p className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider mb-2">Pro Tip</p>
            <p className="text-xs text-[#4B5563] leading-relaxed">
              Include specific keywords from the job description to increase your score.
            </p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="ml-64 p-10 max-w-6xl">
        <AnimatePresence mode="wait">
          {activeTab === "scan" ? (
            <motion.div
              key="scan"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-8"
            >
              <header>
                <h2 className="text-3xl font-bold tracking-tight mb-2">Analyze Your Resume</h2>
                <p className="text-[#6B7280]">Upload your CV and get instant AI-powered feedback.</p>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Left Column: Inputs */}
                <div className="space-y-6">
                  <div className="bg-white p-8 rounded-3xl border border-[#E5E7EB] shadow-sm">
                    <label className="block text-sm font-semibold mb-4">Resume / CV (PDF or Text)</label>
                    <div 
                      className={cn(
                        "border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center transition-all cursor-pointer",
                        file ? "border-[#2563EB] bg-[#EFF6FF]" : "border-[#D1D5DB] hover:border-[#2563EB] hover:bg-[#F9FAFB]"
                      )}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const droppedFile = e.dataTransfer.files[0];
                        if (droppedFile) setFile(droppedFile);
                      }}
                      onClick={() => {
                        const input = document.createElement("input");
                        input.type = "file";
                        input.accept = ".pdf,.txt,.doc,.docx";
                        input.onchange = (e) => {
                          const selectedFile = (e.target as HTMLInputElement).files?.[0];
                          if (selectedFile) setFile(selectedFile);
                        };
                        input.click();
                      }}
                    >
                      <Upload className={cn("w-10 h-10 mb-4", file ? "text-[#2563EB]" : "text-[#9CA3AF]")} />
                      <p className="text-sm font-medium text-[#374151]">
                        {file ? file.name : "Click to upload or drag and drop"}
                      </p>
                      <p className="text-xs text-[#6B7280] mt-1">PDF, TXT up to 10MB</p>
                      {file && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setFile(null);
                          }}
                          className="mt-4 px-3 py-1 bg-white border border-[#E5E7EB] rounded-lg text-xs font-semibold text-[#EF4444] hover:bg-[#FEF2F2] transition-all"
                        >
                          Clear File
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="bg-white p-8 rounded-3xl border border-[#E5E7EB] shadow-sm space-y-4">
                    <div>
                      <label className="block text-sm font-semibold mb-2 flex items-center gap-2">
                        <Target className="w-4 h-4 text-[#2563EB]" />
                        Target Role <span className="text-[#EF4444]">*</span>
                      </label>
                      <input 
                        type="text" 
                        placeholder="e.g. Product Manager"
                        value={targetRole}
                        onChange={(e) => setTargetRole(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-[#D1D5DB] focus:ring-2 focus:ring-[#2563EB] focus:border-transparent outline-none transition-all text-sm"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-2 flex items-center gap-2">
                        <FileText className="w-4 h-4 text-[#2563EB]" />
                        Job Description (Optional)
                      </label>
                      <textarea 
                        rows={6}
                        placeholder="Paste the job description here for a more accurate score..."
                        value={jobDescription}
                        onChange={(e) => setJobDescription(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-[#D1D5DB] focus:ring-2 focus:ring-[#2563EB] focus:border-transparent outline-none transition-all text-sm resize-none"
                      />
                    </div>
                    <button
                      onClick={handleScan}
                      disabled={!file || isScanning}
                      className={cn(
                        "w-full py-4 rounded-xl font-bold text-white transition-all flex items-center justify-center gap-2",
                        !file || isScanning ? "bg-[#9CA3AF] cursor-not-allowed" : "bg-[#2563EB] hover:bg-[#1D4ED8] shadow-lg shadow-blue-200"
                      )}
                    >
                      {isScanning ? (
                        <>
                          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          {history.some(s => s.target_role === targetRole) ? "Comparing with Previous Version..." : "Analyzing..."}
                        </>
                      ) : (
                        <>
                          <Search className="w-5 h-5" />
                          Start ATS Scan
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Right Column: Results */}
                <div className="space-y-6">
                  {result ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="space-y-6"
                    >
                      <div className="flex justify-between items-center">
                        <h2 className="text-lg font-bold text-[#111827]">Scan Results</h2>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={downloadPDF}
                            disabled={isDownloading}
                            className="flex items-center gap-2 px-4 py-2 bg-white border border-[#E5E7EB] rounded-xl text-sm font-semibold text-[#374151] hover:bg-[#F9FAFB] transition-all shadow-sm disabled:opacity-50"
                          >
                            {isDownloading ? (
                              <div className="w-4 h-4 border-2 border-[#374151]/30 border-t-[#374151] rounded-full animate-spin" />
                            ) : (
                              <Download className="w-4 h-4" />
                            )}
                            {isDownloading ? "Generating..." : "Download PDF"}
                          </button>
                          <button
                            onClick={resetScan}
                            className="flex items-center gap-2 px-4 py-2 bg-white border border-[#E5E7EB] rounded-xl text-sm font-semibold text-[#374151] hover:bg-[#F9FAFB] transition-all shadow-sm"
                          >
                            <Plus className="w-4 h-4" />
                            New Scan
                          </button>
                        </div>
                      </div>

                      <div ref={resultsRef} className="space-y-6 p-1">
                        {/* Score Card */}
                      <div className="bg-white p-8 rounded-3xl border border-[#E5E7EB] shadow-sm">
                        <div className="flex flex-col md:flex-row items-center gap-8">
                          <div className="relative inline-flex items-center justify-center shrink-0">
                            <svg className="w-32 h-32 transform -rotate-90">
                              <circle
                                cx="64"
                                cy="64"
                                r="58"
                                stroke="currentColor"
                                strokeWidth="8"
                                fill="transparent"
                                className="text-[#F3F4F6]"
                              />
                              <circle
                                cx="64"
                                cy="64"
                                r="58"
                                stroke="currentColor"
                                strokeWidth="8"
                                fill="transparent"
                                strokeDasharray={364}
                                strokeDashoffset={364 - (364 * result.score) / 100}
                                className={cn(
                                  "transition-all duration-1000 ease-out",
                                  result.score >= 80 ? "text-[#10B981]" : result.score >= 50 ? "text-[#F59E0B]" : "text-[#EF4444]"
                                )}
                              />
                            </svg>
                            <span className="absolute text-3xl font-bold">{result.score}%</span>
                          </div>
                          <div className="text-left space-y-4 flex-1">
                            <div className="flex items-center gap-3">
                              <h3 className="text-xl font-bold">Overall ATS Match</h3>
                              {previousScore !== null && (
                                <span className={cn(
                                  "px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1",
                                  result.score > previousScore ? "bg-green-100 text-green-700" : 
                                  result.score < previousScore ? "bg-red-100 text-red-700" : 
                                  "bg-gray-100 text-gray-700"
                                )}>
                                  {result.score > previousScore ? (
                                    <>
                                      <TrendingUp className="w-3 h-3" />
                                      +{result.score - previousScore}%
                                    </>
                                  ) : result.score < previousScore ? (
                                    <>
                                      <TrendingDown className="w-3 h-3" />
                                      {result.score - previousScore}%
                                    </>
                                  ) : "No change"}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-[#6B7280] mt-1 leading-relaxed">{result.summary}</p>
                            
                            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                              {[
                                { label: "Keywords", val: result.scoreBreakdown.keywordMatch },
                                { label: "Experience", val: result.scoreBreakdown.experienceRelevance },
                                { label: "Impact", val: result.scoreBreakdown.impactAndMetrics },
                                { label: "Format", val: result.scoreBreakdown.formatting },
                              ].map((item) => (
                                <div key={item.label} className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF]">
                                    <span>{item.label}</span>
                                    <span>{item.val}%</span>
                                  </div>
                                  <div className="h-1.5 w-full bg-[#F3F4F6] rounded-full overflow-hidden">
                                    <div 
                                      className="h-full bg-[#2563EB] rounded-full transition-all duration-1000" 
                                      style={{ width: `${item.val}%` }}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Suitability Verdict */}
                      <div className={cn(
                        "p-6 rounded-2xl border flex items-start gap-4",
                        result.score >= 75 ? "bg-[#ECFDF5] border-[#D1FAE5] text-[#065F46]" : "bg-[#FFFBEB] border-[#FEF3C7] text-[#92400E]"
                      )}>
                        <Target className="w-6 h-6 shrink-0 mt-1" />
                        <div>
                          <h4 className="font-bold mb-1">Hiring Manager's Verdict</h4>
                          <p className="text-sm opacity-90 leading-relaxed">{result.roleSuitability}</p>
                        </div>
                      </div>

                      {/* Analysis Details */}
                      <div className="grid grid-cols-1 gap-4">
                        <div className="bg-white p-6 rounded-2xl border border-[#E5E7EB] shadow-sm">
                          <h4 className="text-sm font-bold flex items-center gap-2 mb-4">
                            <CheckCircle2 className="w-4 h-4 text-[#10B981]" />
                            Evidence-Based Strengths
                          </h4>
                          <div className="space-y-4">
                            {result.strengths?.map((s, i) => (
                              <div key={i} className="space-y-1">
                                <p className="text-sm font-semibold text-[#111827]">{s.point}</p>
                                <p className="text-xs text-[#6B7280] italic bg-[#F9FAFB] p-2 rounded-lg border-l-2 border-[#10B981]">
                                  "{s.evidence}"
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="bg-white p-6 rounded-2xl border border-[#E5E7EB] shadow-sm">
                          <h4 className="text-sm font-bold flex items-center gap-2 mb-4">
                            <AlertCircle className="w-4 h-4 text-[#EF4444]" />
                            Actionable Weaknesses
                          </h4>
                          <div className="space-y-4">
                            {result.weaknesses?.map((w, i) => (
                              <div key={i} className="space-y-1">
                                <p className="text-sm font-semibold text-[#111827]">{w.point}</p>
                                <p className="text-xs text-[#2563EB] bg-[#EFF6FF] p-2 rounded-lg">
                                  <span className="font-bold">Recommendation:</span> {w.recommendation}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="bg-white p-6 rounded-2xl border border-[#E5E7EB] shadow-sm">
                          <div className="flex items-center justify-between mb-4">
                            <h4 className="text-sm font-bold flex items-center gap-2">
                              <Target className="w-4 h-4 text-[#8B5CF6]" />
                              Impact Analysis
                            </h4>
                            <span className={cn(
                              "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest",
                              result.impactAnalysis.rating === "Strong" ? "bg-[#ECFDF5] text-[#10B981]" : "bg-[#FFFBEB] text-[#F59E0B]"
                            )}>
                              {result.impactAnalysis.rating}
                            </span>
                          </div>
                          <p className="text-sm text-[#4B5563] mb-4">{result.impactAnalysis.feedback}</p>
                          {result.impactAnalysis.examplesFound.length > 0 && (
                            <div className="space-y-2">
                              <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wider">Quantifiable Achievements Found:</p>
                              <div className="flex flex-wrap gap-2">
                                {result.impactAnalysis.examplesFound.map((ex, i) => (
                                  <span key={i} className="px-2 py-1 bg-[#F3F4F6] text-[#4B5563] text-[10px] rounded border border-[#E5E7EB]">
                                    {ex}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="bg-white p-6 rounded-2xl border border-[#E5E7EB] shadow-sm">
                            <h4 className="text-sm font-bold flex items-center gap-2 mb-4">
                              <CheckCircle2 className="w-4 h-4 text-[#10B981]" />
                              Keywords Found
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {result.keywordsFound?.map((k, i) => (
                                <span key={i} className="px-2 py-1 bg-[#ECFDF5] text-[#10B981] text-[10px] font-semibold rounded-full border border-[#D1FAE5]">
                                  {k}
                                </span>
                              ))}
                            </div>
                          </div>

                          <div className="bg-white p-6 rounded-2xl border border-[#E5E7EB] shadow-sm">
                            <h4 className="text-sm font-bold flex items-center gap-2 mb-4">
                              <AlertCircle className="w-4 h-4 text-[#EF4444]" />
                              Missing Keywords
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {result.missingKeywords?.map((k, i) => (
                                <span key={i} className="px-2 py-1 bg-[#FEF2F2] text-[#EF4444] text-[10px] font-semibold rounded-full border border-[#FEE2E2]">
                                  {k}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="bg-white p-6 rounded-2xl border border-[#E5E7EB] shadow-sm">
                          <h4 className="text-sm font-bold flex items-center gap-2 mb-4">
                            <FileText className="w-4 h-4 text-[#2563EB]" />
                            Formatting Tips
                          </h4>
                          <ul className="space-y-2">
                            {result.formattingTips?.map((t, i) => (
                              <li key={i} className="text-sm text-[#4B5563] flex gap-2">
                                <span className="text-[#2563EB]">•</span> {t}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </motion.div>
                  ) : (
                    <div className="h-full min-h-[400px] bg-white rounded-3xl border border-[#E5E7EB] border-dashed flex flex-col items-center justify-center p-10 text-center">
                      <div className="w-16 h-16 bg-[#F3F4F6] rounded-2xl flex items-center justify-center mb-4">
                        <FileSearch className="text-[#9CA3AF] w-8 h-8" />
                      </div>
                      <h3 className="text-lg font-bold text-[#374151]">No Analysis Yet</h3>
                      <p className="text-sm text-[#6B7280] max-w-[240px] mt-2">
                        Upload your resume and click "Start Scan" to see your results here.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-8"
            >
              <header>
                <h2 className="text-3xl font-bold tracking-tight mb-2">Scan History</h2>
                <p className="text-[#6B7280]">Review your previous resume analyses and track improvements.</p>
              </header>

              <div className="bg-white rounded-3xl border border-[#E5E7EB] shadow-sm overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-[#F9FAFB] border-bottom border-[#E5E7EB]">
                    <tr>
                      <th className="px-6 py-4 text-xs font-bold text-[#6B7280] uppercase tracking-wider">Date</th>
                      <th className="px-6 py-4 text-xs font-bold text-[#6B7280] uppercase tracking-wider">Resume</th>
                      <th className="px-6 py-4 text-xs font-bold text-[#6B7280] uppercase tracking-wider">Target Role</th>
                      <th className="px-6 py-4 text-xs font-bold text-[#6B7280] uppercase tracking-wider">Score</th>
                      <th className="px-6 py-4 text-xs font-bold text-[#6B7280] uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5E7EB]">
                    {history.map((scan) => (
                      <tr key={scan.id} className="hover:bg-[#F9FAFB] transition-colors group">
                        <td className="px-6 py-4 text-sm text-[#4B5563]">
                          {new Date(scan.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <FileText className="w-4 h-4 text-[#2563EB]" />
                            <span className="text-sm font-medium text-[#111827]">{scan.filename}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-[#4B5563]">{scan.target_role}</td>
                        <td className="px-6 py-4">
                          <span className={cn(
                            "px-3 py-1 rounded-full text-xs font-bold",
                            scan.score >= 80 ? "bg-[#ECFDF5] text-[#10B981]" : scan.score >= 50 ? "bg-[#FFFBEB] text-[#F59E0B]" : "bg-[#FEF2F2] text-[#EF4444]"
                          )}>
                            {scan.score}%
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <button 
                              onClick={() => {
                                setResult(scan.analysis);
                                setActiveTab("scan");
                              }}
                              className="p-2 text-[#6B7280] hover:text-[#2563EB] hover:bg-[#EFF6FF] rounded-lg transition-all"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => deleteScan(scan.id)}
                              className="p-2 text-[#6B7280] hover:text-[#EF4444] hover:bg-[#FEF2F2] rounded-lg transition-all opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {history.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-6 py-20 text-center">
                          <p className="text-sm text-[#6B7280]">No scan history found.</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
