# 📚 MoodleCourseDownloader

MoodleScraper is a powerful and automated Node.js application designed to streamline the process of downloading course materials from Moodle. This tool leverages Selenium WebDriver and ChromeDriver to interact with the Moodle website, automating the login and navigation process to ensure you have all your course resources neatly organized in your local directory.

## 🚀 Features

- **Automatic Login**: Securely logs into your Moodle account using the provided credentials.
- **Course Navigation**: Automatically navigates to the specified course URL.
- **Resource Download**: Downloads all accessible resources such as PDFs, images, and other files from each section of the course.
- **Organized Storage**: Saves the downloaded files into structured directories named after each course section.
- **Error Handling**: Gracefully handles missing elements and errors during the scraping process, ensuring robustness.

## 🛠 Installation

### Prerequisites

- **Node.js**: Ensure you have Node.js installed. If not, download and install it from [Node.js](https://nodejs.org/).
- **Google Chrome**: The script uses ChromeDriver, so Google Chrome must be installed on your machine.

### Steps

1. **Clone the repository**

    ```sh
    git clone https://github.com/Niclassslua/MoodleScraper.git
    cd MoodleScraper
    ```

2. **Install dependencies**

    ```sh
    npm install
    ```

3. **Set up environment variables**

    Create a `.env` file in the root directory of the project and add your Moodle credentials and course URL:

    ```env
    MOODLE_URL=https://moodle.example.com
    MOODLE_LOGIN_URL=https://moodle.example.com/login/index.php
    MOODLE_USERNAME=yourusername
    MOODLE_PASSWORD=yourpassword
    COURSE_URL=https://moodle.example.com/course/view.php?id=1234
    ```

## 📦 Usage

### Running the Scraper

Execute the scraper with the following command:

```sh
node scraper.js
```

### Steuerung über das Web-Dashboard

Für eine komfortable Bedienung ohne CLI kannst du das neue React/Tailwind-Dashboard direkt aus dem `webui`-Verzeichnis serven. Da alle Abhängigkeiten über CDNs geladen werden, ist kein Build-Schritt notwendig:

```sh
cd webui
python -m http.server 4173
```

Rufe anschließend [http://localhost:4173](http://localhost:4173) auf. Dort wählst du Kurse aus, aktivierst
Download-Optionen und beobachtest den Fortschritt in Echtzeit. Die UI simuliert bereits den künftigen Integrationsfluss mit dem
CLI-Downloader und dient als visuelles Kontrollzentrum.

### What the Script Does

1. **Initialization**: Sets up Selenium WebDriver with ChromeDriver, configuring it to download files to a temporary directory.
2. **Login**: Navigates to the Moodle login page and enters the provided credentials.
3. **Course Access**: After login, the script navigates to the specified course URL.
4. **Section Handling**: Iterates through each course section, creating corresponding directories.
5. **Resource Downloading**: For each resource, it:
   - Checks for direct download links.
   - If not found, tries to locate alternative links or content.
   - Downloads the file to a temporary directory.
6. **File Organization**: Moves the downloaded files from the temporary directory to the appropriate section directories.

### Technical Details

- **Selenium WebDriver**: Utilized for browser automation. It interacts with the web pages, performing tasks like clicking links, entering text, and downloading files.
- **ChromeDriver**: A standalone server which implements WebDriver's wire protocol for Chromium. It controls the browser and handles all interactions.
- **Node.js**: The runtime environment used to execute the script. Node's asynchronous capabilities are leveraged to handle I/O operations efficiently.
- **File System (fs) Module**: Used for creating directories, moving files, and managing the download process.

## 📁 Project Structure

- `scraper.js`: The main script to run the Moodle scraper.
- `package.json`: Project metadata and dependencies.
- `package-lock.json`: Dependency tree lock file.
- `.env.example`: Example environment file for user configuration.
- `README.md`: Project documentation and instructions.

## 📝 Notes

- Ensure Google Chrome is installed and up to date.
- Adjust the timeouts and waits in the script if you encounter issues with loading times or slow network conditions.
- Keep your `.env` file secure and do not share your credentials.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/Niclassslua/MoodleCourseDownloader/issues). If you want to contribute, please fork the repository and make changes as you'd like. Pull requests are warmly welcomed.

## 📜 License

This project is [MIT](https://opensource.org/licenses/MIT) licensed.

---

Made with ❤️
