// Developed by RJ Nelson
// Updated: 6/20/2025 — Split: scrape-projects.js (project + creator URLs only)

// IMPORTS
import * as cheerio from "cheerio";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import express from "express";

// CONFIG
const URL = "https://www.kickstarter.com/discover/advanced?category_id=3&sort=newest";
const sheetbestUrl = "https://api.sheetbest.com/sheets/0b4bbec2-523b-4f4a-802d-4533850a301d";
const BRIGHT_DATA_TOKEN = "035d375a4192a737e3950e068412c2267a13970718dee0455b68c114a86d5896";

// UTILITIES
const normalize = (str) => str?.toLowerCase().replace(/\s+/g, " ").trim() || "";

// HYBRID: GET PROJECT LIST VIA BRIGHT DATA
const fetchWithBrightData = async (targetUrl) => {
  const brightDataApi = "https://api.brightdata.com/request";
  const body = {
    zone: "web_unlocker1",
    url: targetUrl,
    format: "raw",
    render: true
  };

  try {
    const response = await axios.post(brightDataApi, body, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BRIGHT_DATA_TOKEN}`,
      },
    });
    return response.data;
  } catch (err) {
    console.error("❌ Bright Data fetch failed:", err.message);
    throw err;
  }
};

const extractProjectDataFromHTML = (html) => {
  const $ = cheerio.load(html);
  const projects = [];

  const cards = $("div.project-card-details");

  console.log("🔎 Found project-card-details elements:", cards.length);

  cards.each((_, el) => {
    const projectName = $(el).find("a[href*='/projects/']").first().text().trim();
    const creatorName = $(el).find("a.project-card__creator span.do-not-visually-track").first().text().trim();
    const creatorProfileURL = $(el).find("a[href*='/projects/']").first().attr("href");

    if (projectName && creatorName && creatorProfileURL) {
      projects.push({ projectName, creatorName, creatorProfileURL });
    }
  });

  return projects;
};

const getProjectInfo = async () => {
  const html = await fetchWithBrightData(URL);
  console.log("📃 Bright Data HTML received. Length:", html.length);

  const projects = extractProjectDataFromHTML(html);
  console.log("🔍 Extracted projects:", projects);

  return projects;
};

const fetchExistingSheetData = async () => {
  try {
    const response = await axios.get(sheetbestUrl);
    console.log("📄 Existing rows in Sheet:", response.data);
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error("❌ Sheet.best fetch error:", err.message);
    return [];
  }
};

const postToSheetBest = async (scrapedData) => {
  const existingRows = await fetchExistingSheetData();
  const seen = new Set(
    existingRows.map((r) => `${normalize(r["Project Name"])}|${normalize(r["Creator Name"])}`)
  );

  const newRows = scrapedData.filter((r) => {
    const key = `${normalize(r.projectName)}|${normalize(r.creatorName)}`;
    return !seen.has(key);
  });

  if (newRows.length === 0) {
    console.log("🟡 No new unique projects found to upload.");
    return { uploaded: 0 };
  }

  const payload = newRows.map((r) => ({
    Id: uuidv4(),
    "Project Name": r.projectName,
    "Creator Name": r.creatorName,
    "Creator Profile URL": r.creatorProfileURL,
    "Scraped At": new Date().toISOString(),
  }));

  console.log("📤 Uploading payload to Sheet.best:", payload);

  try {
    await axios.post(sheetbestUrl, payload, {
      headers: { "Content-Type": "application/json" },
    });
    console.log(`✅ Uploaded ${payload.length} rows`);
    return { uploaded: payload.length };
  } catch (err) {
    console.error("❌ Upload error:", err.message);
    return { uploaded: 0, error: err.message };
  }
};

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("✅ Server running"));

app.post("/run", async (req, res) => {
  console.log("🔁 /run request received");

  try {
    const projectData = await getProjectInfo();
    console.log("👁️ Scraped Projects:", projectData);

    const result = await postToSheetBest(projectData);
    console.log("📊 Sheet.best result:", result);

    res.json({ message: "✅ Script completed", projectsScraped: projectData.length, ...result });
  } catch (err) {
    console.error("❌ Scrape error:", err.message);
    res.status(500).json({ error: "Script failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
