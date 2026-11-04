// Example programs shown in the "Examples" menu. Add your own: {group, title, code}.
window.PYVIZ_EXAMPLES = [
    {
    group: 'intro',
    title: 'Secret number',
    code: `secret = 7
guess = int(input('Guess the number: '))
if guess == secret:
    print('Correct!')
else:
    print('Wrong!')
`,
  },
  {
    group: 'Loops',
    title: 'while: if vs while',
    code: `spam = 0
while spam < 5:
    print('Hello, world.')
    spam = spam + 1
print(spam)
`,
  },
  {
    group: 'Loops',
    title: 'while: countdown',
    code: `n = 5
while n > 0:
    print(n)
    n -= 1
print('Blastoff!')
`,
  },
  {
    group: 'Loops',
    title: 'while: Collatz sequence',
    code: `n = 6
while n != 1:
    print(n)
    if n % 2 == 0:
        n = n // 2
    else:
        n = n * 3 + 1
print(n)
`,
  },
  {
    group: 'Loops',
    title: 'break: type your name (input)',
    code: `while True:
    print('Please type your name.')
    name = input('>')
    if name == 'your name':
        break
print('Thank you!')
`,
  },
  {
    group: 'Loops',
    title: 'continue: login checker (input)',
    code: `while True:
    print('Who are you?')
    name = input()
    if name != 'Joe':
        continue
    print('Hello, Joe. What is the password? (It is a fish.)')
    password = input()
    if password == 'swordfish':
        break
print('Access granted.')
`,
  },
  {
    group: 'Loops',
    title: 'continue trap (infinite loop!)',
    code: `i = 0
while i < 5:
    if i == 2:
        continue
    print(i)
    i += 1
`,
  },
  {
    group: 'Loops',
    title: 'for: letters in a string',
    code: `word = 'banana'
count = 0
for letter in word:
    if letter == 'a':
        count += 1
print(count)
`,
  },
  {
    group: 'Loops',
    title: 'for: Make Way for Ducklings',
    code: `prefixes = 'JKLMNOPQ'
suffix = 'ack'

for letter in prefixes:
    print(letter + suffix)
`,
  },
  {
    group: 'Loops',
    title: 'for vs while with range()',
    code: `for i in range(3):
    print(f'for: i is {i}')

i = 0
while i < 3:
    print(f'while: i is {i}')
    i += 1
`,
  },
  {
    group: 'Loops',
    title: 'Nested loops',
    code: `for row in range(1, 4):
    for col in range(1, 4):
        print(f'{row} x {col} = {row * col}')
`,
  },
  {
    group: 'Loops',
    title: 'Guess the number (input)',
    code: `import random
secret_number = random.randint(1, 20)
print('I am thinking of a number between 1 and 20.')

for guesses_taken in range(1, 7):
    print('Take a guess.')
    guess = int(input('>'))
    if guess < secret_number:
        print('Your guess is too low.')
    elif guess > secret_number:
        print('Your guess is too high.')
    else:
        break

if guess == secret_number:
    print(f'Good job! You got it in {guesses_taken} guesses!')
else:
    print(f'Nope. The number was {secret_number}')
`,
  },
  {
    group: 'Functions',
    title: 'Calling a function',
    code: `def square(x):
    result = x * x
    return result

a = square(3)
b = square(a)
print(a, b)
`,
  },
  {
    group: 'Functions',
    title: 'Recursion: factorial',
    code: `def factorial(n):
    if n == 0:
        return 1
    return n * factorial(n - 1)

print(factorial(4))
`,
  },
  {
    group: 'Lists, dicts & objects',
    title: 'Aliasing: two names, one list',
    code: `a = [1, 2, 3]
b = a
b.append(4)
c = a[:]
c.append(5)
print(a, b, c)
`,
  },
  {
    group: 'Lists, dicts & objects',
    title: 'Counting words with a dict',
    code: `words = ['to', 'be', 'or', 'not', 'to', 'be']
counts = {}
for w in words:
    if w in counts:
        counts[w] += 1
    else:
        counts[w] = 1
print(counts)
`,
  },
  {
    group: 'Lists, dicts & objects',
    title: 'A class and objects',
    code: `class Dog:
    def __init__(self, name):
        self.name = name
        self.tricks = []

    def add_trick(self, trick):
        self.tricks.append(trick)

rex = Dog('Rex')
rex.add_trick('sit')
rex.add_trick('roll over')
`,
  },
];
