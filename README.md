# AccessAssist

A community-driven accessibility mapping platform that helps users discover, evaluate, and contribute accessibility information for locations in Vijayawada.

## Live Demo

[AccessAssist](https://accessassist.vercel.app/)

## About the Project

AccessAssist is a web application designed to help users find places based on their individual accessibility requirements.

Users can explore locations on an interactive map, view accessibility information, report accessibility barriers, add new locations, and contribute verification data to improve the reliability of accessibility information.

The application provides personalized accessibility scoring for different requirements including wheelchair access, walking assistance, low vision, stroller access, and elderly-friendly facilities.

## Key Features

- Interactive map using Leaflet.js and OpenStreetMap
- Location search and discovery
- Personalized accessibility scoring
- Accessibility feature tagging
- Accessibility barrier reporting
- Community-based location verification
- User registration and authentication
- Separate user and admin access
- Admin dashboard for reviewing locations and accessibility barriers
- Photo and note support for accessibility verification
- Offline map tile caching
- Password reset functionality
- Accessibility-focused location information

## Technologies Used

- React.js
- JavaScript
- Vite
- Supabase
- Leaflet.js
- React Leaflet
- OpenStreetMap
- HTML5
- CSS3

## Application Architecture

```text
User
  ↓
React.js Frontend
  ↓
Leaflet.js + OpenStreetMap
  ↓
Supabase
  ├── Authentication
  ├── User Profiles
  └── Accessibility Data
