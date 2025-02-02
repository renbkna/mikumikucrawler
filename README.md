# Miku Miku Crawler

A **real-time** web crawler powered by **Puppeteer, Cheerio, and Socket.io**, featuring a dynamic frontend with **real-time stats, animations, and a Miku-powered theme**. This project crawls a website, extracts links, and displays **live crawling progress** with interactive visuals.

Inspired by [MikuMikuBeam](https://github.com/sammwyy/MikuMikuBeam) by [Sammwy](https://github.com/sammwyy), with styles and animations adapted from its **index.css**.

![Miku Crawler Preview](https://cdn.discordapp.com/attachments/718157319233339488/1335472231656194078/image.png?ex=67a04aef&is=679ef96f&hm=1a88e997386d787c052733876123ab8f9ffee24db8fe2041bb46976238c79f15&)

## 🌟 Features

✅ **Real-Time Crawling:** Uses **Socket.io** for real-time updates.  
✅ **Dynamic Content Support:** Uses **Puppeteer** to crawl JavaScript-heavy sites.  
✅ **Link Extraction:** Extracts **internal links** and follows them.  
✅ **Live Stats:** Displays **Pages Scanned, Links Found, Data (KB)** in real time.  
✅ **Miku UI Effects:** Animated visuals, flashing effects, and an **interactive UI**.  
✅ **SQLite Storage:** Saves crawled pages in a database for later analysis.  
✅ **Configurable Settings:** Adjust depth, max pages, and delay from the UI.

## 🚀 Setup & Installation

### 1️⃣ Clone the Repository

```sh
git clone https://github.com/yourusername/miku-web-crawler.git
cd miku-web-crawler
```

### 2️⃣ Install Dependencies

```sh
# Backend (Express + Puppeteer + SQLite)
cd server
npm install

# Frontend (React + Vite + Tailwind)
cd ../client
npm install
```

### 3️⃣ Start the Backend

```sh
cd server
npm run start
```

_Defaults to `http://localhost:3000`._

### 4️⃣ Start the Frontend

```sh
cd client
npm run dev
```

_Defaults to `http://localhost:5173`._

## ⚙️ Configuration

| Option        | Description                 | Default |
| ------------- | --------------------------- | ------- |
| `target`      | Website to crawl            | -       |
| `crawlDepth`  | How deep to crawl (1-5)     | `2`     |
| `maxPages`    | Max pages to scan           | `50`    |
| `crawlDelay`  | Delay between requests (ms) | `1000`  |
| `crawlMethod` | `links`, `content`, `media` | `links` |

## 🎨 UI & Features

- **Flashing red effects** when charging (Miku power-up mode).
- **Smooth animation transitions** while crawling.
- **Real-time stats panel** updates as new pages are scanned.
- **Logs section** displays events like errors, scanned pages, and extracted links.

## 📜 API Endpoints

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

1. **Enter a URL**, choose depth, and start the crawler.
2. **Backend processes pages** using **Puppeteer** or **Cheerio**.
3. Extracted links are **queued and crawled recursively**.
4. **Real-time updates** are sent to the frontend via **Socket.io**.
5. **Data is stored** in SQLite for persistence.

## ❗ Important Notes

- This project is for **educational purposes only**. Please **do not crawl sites without permission**.
- **Respect `robots.txt`** and **server rate limits**.

## 🛠️ Technologies Used

- **Frontend:** React + Tailwind + Vite + Socket.io
- **Backend:** Node.js + Express + Puppeteer + Cheerio + SQLite
- **Storage:** SQLite (Persistent Crawled Pages)

## 👨‍💻 Contributors

- **[renbkna](https://github.com/renbkna)** - Developer

## 📜 License

This project is **MIT licensed**. See `LICENSE` for details.

---

🌸 **Miku Miku Crawler - Because Web Crawling Should Be Kawaii Too!** 🌸
