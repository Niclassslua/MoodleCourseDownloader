# MoodleCourseDownloader
MoodleCourseDownloader is a Node.js script that automates the downloading of content from Moodle courses using Selenium. It logs into your Moodle account, navigates to the specified course, and downloads all available resources and files.

## ✨ Features

- 🔐 **Automated Login**: Automatically logs into your Moodle account.
- 📥 **Course Content Download**: Downloads all resources and files from the specified course.
- ⚠️ **Error Handling**: Robust error handling for network issues and dynamic content.
- ⚙️ **Easy Configuration**: Use `.env` files to store your credentials and course information.

## 📋 Prerequisites

- 🟢 Node.js
- 🟡 Selenium WebDriver
- 🟠 Chrome and ChromeDriver

## 💻 Installation

1. **Clone the Repository**
   ```sh
   git clone https://github.com/your-username/MoodleCourseDownloader.git
   cd MoodleCourseDownloader
   ```

2. **Install Dependencies**
   ```sh
   npm install
   ```

3. **Create a .env File**
   Create a `.env` file in the root directory of the project and add your Moodle credentials and course information:
   ```plaintext
   MOODLE_URL=https://moodle.example.com
   MOODLE_LOGIN_URL=https://moodle.example.com/login/index.php
   MOODLE_USERNAME=your-username
   MOODLE_PASSWORD=your-password
   COURSE_URL=https://moodle.example.com/course/view.php?id=course-id
   ```

## 🚀 Usage

Run the script:
```sh
node index.js
```

The script will automatically log into your Moodle account, navigate to the specified course, and download all available resources.
