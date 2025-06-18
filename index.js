// Developed by RJ Nelson
// 6/15/2025

// IMPORTS
import express from "express";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

// CONFIG
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const URL = "https://www.kickstarter.com/discover/advanced?category_id=3&sort=newest";
const sheetbestUrl = "https://api.sheetbest.com/sheets/8450bf12-4a9d-43e5-bc50-8696cc402eb1";

// FUNCTIONS

const launchBrowser = async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  console.log("Launched browser");

  return { browser, page };
};

const getProjectInfo = async (page) => {
  const projectData = await page.evaluate(() => {
    const projectCards = document.querySelectorAll(".js-react-proj-card");

    return [...projectCards].map((card) => {
      const projectNameEl = card.querySelector(".project-card__title");
      const creatorNameEl = card.querySelector(".project-card__creator .do-not-visually-track");
      const creatorLinkEl = card.querySelector(".project-card__creator");

      return {
        projectName: projectNameEl?.textContent.trim() || null,
        creatorName: creatorNameEl?.textContent.trim() || null,
        creatorProfile: creatorLinkEl?.href || null,
      };
    });
  });

  return projectData;
};

const fetchExistingSheetData = async () => {
  try {
    const response = await axios.get(sheetbestUrl);
    const rows = response.data;
    if (!rows || rows.length === 0) {
      console.log("ℹ️ No existing data found. First run.");
    }
    return rows || [];
  } catch (error) {
    console.error("❌ Error fetching existing sheet data:", error.message);
    return [];
  }
};

const postToSheetBest = async (scrapedData) => {
  const existingRows = await fetchExistingSheetData();

  const normalize = (str) =>
    str?.toLowerCase().replace(/\s+/g, " ").trim() || "";

  const seenKeys = new Set(
    existingRows.map(
      (row) =>
        `${normalize(row["Project Name"])}|${normalize(row["Creator Name"])}`
    )
  );

  const newRows = scrapedData.filter((item) => {
    if (!item.projectName || !item.creatorName) return false;
    const key = `${normalize(item.projectName)}|${normalize(item.creatorName)}`;
    return !seenKeys.has(key);
  });

  if (newRows.length === 0) {
    console.log("🟡 No new unique projects found to upload.");
    return { uploaded: 0 };
  }

  const payload = newRows.map((item) => ({
    Id: uuidv4(),
    "Project Name": item.projectName,
    "Creator Name": item.creatorName,
    "Creator Profile": item.creatorProfile,
    "Scraped At": new Date().toISOString(),
  }));

  try {
    await axios.post(sheetbestUrl, payload, {
      headers: { "Content-Type": "application/json" },
    });
    console.log(`✅ Uploaded ${payload.length} new rows to Google Sheet.`);
    return { uploaded: payload.length };
  } catch (error) {
    console.error("❌ Upload error:", error.message);
    return { uploaded: 0, error: error.message };
  }
};

// ROUTE - Reflects message on Render URL that the server is up and running
app.get("/", (req, res) => {
    res.send("✅ Render server is up and responding to GET /");
  });

// ROUTE — Trigger this via HTTP POST
app.post("/run", async (req, res) => {
  console.log("🔁 Received /run request");

  try {
    const { browser, page } = await launchBrowser();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const projectData = await getProjectInfo(page);
    await browser.close();
    const result = await postToSheetBest(projectData);
    res.json({ message: "✅ Script completed", projectsScraped: projectData.length, ...result });
  } catch (error) {
    console.error("❌ Script error:", error.message);
    res.status(500).json({ error: "Internal script error", details: error.message });
  }
});

// START SERVER
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
