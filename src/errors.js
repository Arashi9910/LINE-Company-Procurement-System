export class AppError extends Error {
  constructor(message, { code = 'INTERNAL_ERROR', status = 500, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, details });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'LINE 身分驗證失敗') {
    super(message, { code: 'AUTHENTICATION_ERROR', status: 401 });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = '你沒有執行這項操作的權限') {
    super(message, { code: 'AUTHORIZATION_ERROR', status: 403 });
  }
}

export class ConflictError extends AppError {
  constructor(message, details) {
    super(message, { code: 'CONFLICT', status: 409, details });
  }
}
