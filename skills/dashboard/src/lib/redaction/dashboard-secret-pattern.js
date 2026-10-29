// Shared with the Fleet response guard. Keep credential formats in one place.
export const SECRET_PATTERN =
  /\b(?:Bearer\s+zylos_st_[A-Za-z0-9_-]+|zylos_st_[A-Za-z0-9_-]+|zylos_ak_[A-Za-z0-9_-]+|read_api_key|read_session_token)\b/i;
