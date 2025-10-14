const LOGIN_SELECTORS = {
    usernameInput: 'input[name="username"]',
    passwordInput: 'input[name="password"]',
    loginButton: '#loginbtn',
};

const MOODLE_SELECTORS = {
    courseTitle: '.page-header-headings h1',
    courseContent: '.course-content',
    section: 'li.section',
    sectionAriaLabel: 'aria-label',
    sectionHeader: 'h3.sectionname',
    activity: '.activity',
    activityName: '.instancename',
    activityLink: 'a',
    sectionTitleSelectors: [
        'h3.sectionname',
        'h3.sectionname span',
        '.sectionname',
        '.section-title',
        '.section_title',
        '.section .sectionname',
        '.content .sectionname',
        '.section .content .sectionname',
        '.section .section-title h3',
        '.section .section-header h3',
        'h3.sectionname.course-content-item'
    ],
};

const RESOURCE_SELECTORS = {
    resourceContentLink: '.resourcecontent a[href*="pluginfile.php"]',
    resourceContentImage: '.resourcecontent img[src*="pluginfile.php"]',
};

const FORUM_SELECTORS = {
    discussionList: '[id^="discussion-list-"]',
    discussionRow: 'tr.discussion',
    threadTitle: 'th.topic a',
    forumPostContainer: 'article.forum-post-container',
    userAvatar: '.userpicture',
    postContent: '.post-content-container',
};

const DOWNLOADER_SELECTORS = {
    downloadInProgress: '.crdownload',
};

const FOLDER_SELECTORS = {
    folderLinks: '.fp-filename-icon a',
    folderFileName: '.fp-filename',
};

const QUIZ_SELECTORS = {
    attemptSummary: '.generaltable.quizattemptsummary',
    questionContainer: '.que',
    questionText: '.qtext',
    answerOption: '.answer div',
    startButton: '.singlebutton.quizstartbuttondiv button',
};

module.exports = {
    LOGIN_SELECTORS,
    MOODLE_SELECTORS,
    RESOURCE_SELECTORS,
    FORUM_SELECTORS,
    DOWNLOADER_SELECTORS,
    FOLDER_SELECTORS,
    QUIZ_SELECTORS,
};
