// Developed by RJ Nelson
// Updated: 6/19/2025 — Bright Data + Cheerio + Puppeteer hybrid

// IMPORTS
import puppeteer from "puppeteer-extra";
import puppeteerLib from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import express from "express";

puppeteer.use(StealthPlugin());
puppeteer.executablePath = puppeteerLib.executablePath();

// CONFIG
const URL =
  "https://www.kickstarter.com/discover/advanced?category_id=3&sort=newest";
const sheetbestUrl =
  "https://api.sheetbest.com/sheets/0b4bbec2-523b-4f4a-802d-4533850a301d";
const BRIGHT_DATA_TOKEN =
  "035d375a4192a737e3950e068412c2267a13970718dee0455b68c114a86d5896";

// UTILITIES
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const normalize = (str) => str?.toLowerCase().replace(/\s+/g, " ").trim() || "";

// HYBRID: GET PROJECT LIST VIA BRIGHT DATA
const fetchWithBrightData = async (targetUrl) => {
  const brightDataApi = "https://api.brightdata.com/request";

  const body = {
    zone: "web_unlocker1",
    url: targetUrl,
    format: "raw",
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
    console.error("\u274C Bright Data fetch failed:", err.message);
    throw err;
  }
};

const extractProjectDataFromHTML = (html) => {
  const $ = cheerio.load(html); // ✅ Fixed usage
  const projects = [];

  $("a.project-card__title").each((_, el) => {
    const link = $(el);
    const projectName = link.text().trim();
    const creatorProfile = link.attr("href");

    const parent = link.closest(".project-card-details");
    const creatorName = $(parent)
      .find("a.project-card__creator span.do-not-visually-track")
      .text()
      .trim();

    if (projectName && creatorName && creatorProfile) {
      projects.push({ projectName, creatorName, creatorProfile });
    }
  });

  return projects;
};

const getProjectInfo = async () => {
  const html = await fetchWithBrightData(URL);
  return extractProjectDataFromHTML(html);
};

// SHEET.BEST SUPPORT
const fetchExistingSheetData = async () => {
  try {
    const response = await axios.get(sheetbestUrl);
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error("\u274C Sheet.best fetch error:", err.message);
    return [];
  }
};

// PUPPETEER: USED ONLY FOR CREATOR BIO
const launchBrowser = async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/117 Safari/537.36"
  );
  return { browser, page };
};

const enrichWithCreatorBio = async (page, row) => {
  const cleanBase = row.creatorProfile?.split("?")[0];
  const creatorUrl = `${cleanBase}/creator`;

  try {
    await page.goto(creatorUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector("section.js-project-creator-content", {
      timeout: 20000,
    });

    const elSelector =
      "div.text-preline.do-not-visually-track.kds-type.kds-type-body-md";
    await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
    await page.waitForSelector(elSelector, { timeout: 15000 });

    const bio = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el?.innerText.trim() || "No bio found.";
    }, elSelector);

    row.creatorBio = bio;
  } catch (err) {
    console.error("\u274C Error loading creator bio:", err.message);
    row.creatorBio = "Error fetching bio";
  }
};

// SHEET.BEST UPLOAD
const postToSheetBest = async (scrapedData) => {
  const existingRows = await fetchExistingSheetData();

  const seen = new Set(
    existingRows.map(
      (r) => `${normalize(r["Project Name"])}|${normalize(r["Creator Name"])}`
    )
  );

  const newRows = scrapedData.filter((r) => {
    if (!r.projectName || !r.creatorName) return false;
    const key = `${normalize(r.projectName)}|${normalize(r.creatorName)}`;
    return !seen.has(key);
  });

  if (newRows.length === 0) {
    console.log("\uD83D\uDFE1 No new unique projects found to upload.");
    return { uploaded: 0 };
  }

  const { browser, page } = await launchBrowser();
  for (const row of newRows) {
    await enrichWithCreatorBio(page, row);
    await sleep(1000);
  }
  await browser.close();

  const payload = newRows.map((r) => ({
    Id: uuidv4(),
    "Project Name": r.projectName,
    "Creator Name": r.creatorName,
    "Creator Profile": r.creatorProfile,
    "Creator Bio": r.creatorBio || "N/A",
    "Scraped At": new Date().toISOString(),
  }));

  try {
    await axios.post(sheetbestUrl, payload, {
      headers: { "Content-Type": "application/json" },
    });
    console.log(`\u2705 Uploaded ${payload.length} rows`);
    return { uploaded: payload.length };
  } catch (err) {
    console.error("\u274C Upload error:", err.message);
    return { uploaded: 0, error: err.message };
  }
};

// EXPRESS SERVER
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("\u2705 Server running"));

app.post("/run", async (req, res) => {
  console.log("\uD83D\uDD01 /run request received");

  try {
    const projectData = await getProjectInfo();
    const result = await postToSheetBest(projectData);
    res.json({
      message: "\u2705 Script completed",
      projectsScraped: projectData.length,
      ...result,
    });
  } catch (err) {
    console.error("\u274C Scrape error:", err.message);
    res.status(500).json({ error: "Script failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\uD83D\uDE80 Server listening on ${PORT}`));
