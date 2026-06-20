const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error("JWT_SECRET must be set to at least 32 characters");
}
const EXPIRES_IN = '7d'; // 7 days — balance between security and mobile UX

// Pin the algorithm on BOTH sign and verify (OWASP JWT guidance) so a forged
// token can't downgrade to "none" or swap to an asymmetric alg.
function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN, algorithm: "HS256" });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET, { algorithms: ["HS256"] });
}

module.exports = { signToken, verifyToken };
