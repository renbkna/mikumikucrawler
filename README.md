# Miku Miku Crawler

A **real-time** web crawler powered by **Puppeteer, Cheerio, and Socket.io**, featuring a dynamic frontend with **real-time stats, animations, and a Miku-powered theme**. This project crawls a website, extracts links, and displays **live crawling progress** with interactive visuals.

Inspired by [MikuMikuBeam](https://github.com/sammwyy/MikuMikuBeam) by [Sammwy](https://github.com/sammwyy), with styles and animations adapted from her **index.css**.

![Miku Crawler Preview](./public/mikumikucrawler.jpeg)

## 🌟 Features

✅ **Real-Time Crawling:** Uses **Socket.io** for live updates.  
✅ **Dynamic Content Support:** Crawls JavaScript-heavy sites with **Puppeteer**.  
✅ **Link Extraction:** Finds and follows **internal links** automatically.  
✅ **Live Stats:** Displays **Pages Scanned, Links Found, Data (KB)** in real-time.  
✅ **Miku UI Effects:** Flashy visuals, interactive animations, and fun effects.  
✅ **SQLite Storage:** Saves crawled pages for later review.  
✅ **Configurable Settings:** Adjust crawl depth, max pages, and delay in the UI.

## 🚀 Setup & Installation

### 🏗 Clone the Repository

```sh
git clone https://github.com/renbkna/mikumikucrawler
cd mikumikucrawler
```

### 🔧 Install Dependencies

```sh
npm install
```

### 🚦 Start the Server

```sh
npm run dev
```

Defaults to `frontend on http://localhost:5173, backend on port 3000.`

## ⚙️ Configuration

| Option        | Description                 | Default |
| ------------- | --------------------------- | ------- |
| `target`      | Website to crawl            | -       |
| `crawlDepth`  | Crawl depth (1-5)           | `2`     |
| `maxPages`    | Maximum pages to scan       | `50`    |
| `crawlDelay`  | Delay between requests (ms) | `1000`  |
| `crawlMethod` | `links`, `content`, `media` | `links` |

## 🎨 UI & Features

- **Flashing Miku effects** when active.  
- **Smooth animations** during crawling.  
- **Live stats panel** updates instantly.  
- **Event log** shows errors, scanned pages, and links found.

## 🔍 API Endpoints

### Health Check

```sh
GET /health
```

_Response:_

```json
{
  "status": "ok",
  "activeCrawls": 1
}
```

## 💡 How It Works

1. **Enter a URL**, adjust settings, and start crawling.
2. **Backend processes pages** via **Puppeteer** or **Cheerio**.
3. Extracted links are **queued and recursively crawled**.
4. **Real-time updates** are sent to the frontend.
5. **Data is stored** in SQLite.

## ⚠️ Important Notes

- This is for **educational purposes only**. Do **not** crawl sites without permission.
- Always respect `robots.txt`.

## 🔧 Technologies Used

- **Frontend:** React + Tailwind + Vite + Socket.io  
- **Backend:** Node.js + Express + Puppeteer + Cheerio + SQLite  
- **Storage:** SQLite (Persistent Crawled Pages)

## 👨‍💻 Contributors

- **[renbkna](https://github.com/renbkna)** - Developer

## 📜 License

This project is **MIT licensed**. See `LICENSE` for details.

---

🌸 **Miku Miku Crawler - Because Web Crawling Should Be Kawaii Too!** 🌸
