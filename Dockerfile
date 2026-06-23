# Use a lightweight Node.js Alpine base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy the rest of the application files
COPY . .

# Expose the dashboard's web interface port
EXPOSE 3000

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Run the server
CMD ["node", "server.js"]
