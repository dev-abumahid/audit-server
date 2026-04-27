export const otpGenerator = (): string => {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const symbols = '@#$%&*!?';

  const allChars = upper + lower + numbers + symbols;

  let otp = '';

  // Ensure at least one character from each set
  otp += upper[Math.floor(Math.random() * upper.length)];
  otp += lower[Math.floor(Math.random() * lower.length)];
  otp += numbers[Math.floor(Math.random() * numbers.length)];
  otp += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill the rest randomly
  for (let i = otp.length; i < 6; i++) {
    otp += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Shuffle to remove predictable order
  otp = otp
    .split('')
    .sort(() => Math.random() - 0.5)
    .join('');

  return otp;
};
