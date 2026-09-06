const clock = document.getElementById("clock");
const date = document.getElementById("date");


const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

function updateClock() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const seconds = now.getSeconds().toString().padStart(2, "0");

  const diurnalIndicator = hours >= 12 ? "PM" : "AM";
  const displayHours = (hours % 12 || 12).toString().padStart(2, "0"); // Convert to 12-hour format

  clock.innerHTML = stringToMonospaceSpans(`${displayHours}${seconds % 2 ? ':' : ' '}${minutes} ${diurnalIndicator}`);

  const day = now.getDate()
  const month = (now.getMonth() + 1).toString().padStart(2, "0"); // Months are zero-based
  const year = now.getFullYear();


  const dayName = days[now.getDay()];
  const monthName = months[now.getMonth()];

  const orderedDate = day == '01' ? '1st' : day == '02' ? '2nd' : day == '03' ? '3rd' : `${day}th`;

    date.innerHTML = stringToMonospaceSpans(`${dayName}, ${orderedDate} of ${monthName}  ${year}`);

//   date.textContent = `${day}/${month}/${year}`;
}

// Update the clock immediately and then every second
updateClock();
setInterval(updateClock, 1000);



