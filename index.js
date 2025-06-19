// Developed by RJ Nelson
// Updated: 6/19/2025 — Cleaned + Updated DOM selectors

// IMPORTS
import puppeteer from "puppeteer-extra";
import puppeteerLib from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import express from "express";

puppeteer.use(StealthPlugin());
puppeteer.executablePath = puppeteerLib.executablePath();

// CONFIG
const URL = "https://www.kickstarter.com/discover/advanced?category_id=3&sort=newest";
const sheetbestUrl = "https://api.sheetbest.com/sheets/0b4bbec2-523b-4f4a-802d-4533850a301d";

// UTILITIES
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const normalize = (str) => str?.toLowerCase().replace(/\s+/g, " ").trim() || "";

// MAIN SCRAPER
const launchBrowser = async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/117 Safari/537.36");
  return { browser, page };
};

const getProjectInfo = async (page) => {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });

  // Wait for at least one project card title to appear
  try {
    await page.waitForSelector("a.project-card__title", { timeout: 30000 });
  } catch (err) {
    const html = await page.content();
    console.error("❌ .project-card__title not found — dumping HTML snippet:");
    console.error(html.slice(0, 1000));
    throw err;
  }

  // Extract data using updated selectors
  return await page.evaluate(() => {
    const cards = document.querySelectorAll("a.project-card__title");

    return [...cards].map((link) => {
      const projectName = link?.innerText?.trim() || null;
      const creatorProfile = link?.href || null;

      const parent = link.closest(".project-card-details");
      const creatorName = parent?.querySelector("a.project-card__creator span.do-not-visually-track")?.innerText?.trim() || null;

      return { projectName, creatorName, creatorProfile };
    });
  });
};

const fetchExistingSheetData = async () => {
  try {
    const response = await axios.get(sheetbestUrl);
    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error("❌ Sheet.best fetch error:", err.message);
    return [];
  }
};

const enrichWithCreatorBio = async (page, row) => {
  const cleanBase = row.creatorProfile?.split("?")[0];
  const creatorUrl = `${cleanBase}/creator`;

  try {
    await page.goto(creatorUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("section.js-project-creator-content", { timeout: 20000 });

    const elSelector = "div.text-preline.do-not-visually-track.kds-type.kds-type-body-md";
    await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
    await page.waitForSelector(elSelector, { timeout: 15000 });

    const bio = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el?.innerText.trim() || "No bio found.";
    }, elSelector);

    row.creatorBio = bio;
  } catch (err) {
    console.error("❌ Error loading creator bio:", err.message);
    row.creatorBio = "Error fetching bio";
  }
};

const postToSheetBest = async (scrapedData) => {
  const existingRows = await fetchExistingSheetData();

  const seen = new Set(
    existingRows.map((r) => `${normalize(r["Project Name"])}|${normalize(r["Creator Name"])}`)
  );

  const newRows = scrapedData.filter((r) => {
    if (!r.projectName || !r.creatorName) return false;
    const key = `${normalize(r.projectName)}|${normalize(r.creatorName)}`;
    return !seen.has(key);
  });

  if (newRows.length === 0) {
    console.log("🟡 No new unique projects found to upload.");
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
    console.log(`✅ Uploaded ${payload.length} rows`);
    return { uploaded: payload.length };
  } catch (err) {
    console.error("❌ Upload error:", err.message);
    return { uploaded: 0, error: err.message };
  }
};

// EXPRESS HANDLER FOR RENDER
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("✅ Server running"));

app.post("/run", async (req, res) => {
  console.log("🔁 /run request received");

  try {
    const { browser, page } = await launchBrowser();
    const projectData = await getProjectInfo(page);
    await browser.close();

    const result = await postToSheetBest(projectData);
    res.json({ message: "✅ Script completed", projectsScraped: projectData.length, ...result });
  } catch (err) {
    console.error("❌ Scrape error:", err.message);
    res.status(500).json({ error: "Script failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
