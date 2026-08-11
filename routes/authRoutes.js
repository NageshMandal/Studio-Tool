const express = require('express');
const router = express.Router();
const { loginPage, login, logout } = require('../controllers/authController');
const { redirectIfAuth } = require('../middleware/auth');

router.get('/login', redirectIfAuth, loginPage);
router.post('/login', login);
router.get('/logout', logout);

module.exports = router;
